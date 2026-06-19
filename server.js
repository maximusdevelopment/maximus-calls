require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const axios = require('axios');
const sgMail = require('@sendgrid/mail');

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

const BASE_URL = process.env.BASE_URL || 'https://maximus-calls.onrender.com';
const MAXIMUS_PHONE = process.env.MAXIMUS_PHONE || '+19162229729';
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const EMAIL_FROM = process.env.EMAIL_FROM || 'support@maximusroof.com';

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
} else {
  console.log('SENDGRID_API_KEY missing. Emails will be skipped.');
}

const MAX_CALL_ATTEMPTS = 6;

let callbackQueue = [];
let callMap = {};

function formatPhone(rawPhone) {
  if (!rawPhone) return null;

  const original = String(rawPhone).trim();
  if (original.startsWith('+')) return original;

  const digits = original.replace(/\D/g, '');

  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;

  return null;
}

function extractPhone(body) {
  return (
    body.phone ||
    body.mobilephone ||
    body.properties?.phone ||
    body.properties?.mobilephone ||
    body.phone_number ||
    null
  );
}

function getPacificParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit'
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value;

  return {
    weekday: get('weekday'),
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute'))
  };
}

function getPacificDate() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles'
  });
}

function isBusinessHoursPacific() {
  const { weekday, hour } = getPacificParts();
  return weekday !== 'Sat' && weekday !== 'Sun' && hour >= 8 && hour < 18;
}

function getPacificOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset'
  }).formatToParts(date);

  const tz = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-7';
  const match = tz.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);

  if (!match) return -420;

  const hours = Number(match[1]);
  const minutes = Number(match[2] || 0);

  return hours * 60 + Math.sign(hours) * minutes;
}

function pacificLocalToUTCISOString(target) {
  const offsetMinutes = getPacificOffsetMinutes(target);

  const utcMs =
    Date.UTC(
      target.getFullYear(),
      target.getMonth(),
      target.getDate(),
      target.getHours(),
      target.getMinutes(),
      0
    ) - offsetMinutes * 60 * 1000;

  return new Date(utcMs).toISOString();
}

function getNextBusinessMorningPacific(hour = 9, minute = 0) {
  const p = getPacificParts();

  let target = new Date(p.year, p.month - 1, p.day, hour, minute, 0, 0);
  const todayIsWeekday = p.weekday !== 'Sat' && p.weekday !== 'Sun';

  if (!todayIsWeekday || p.hour >= hour) {
    target.setDate(target.getDate() + 1);
  }

  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }

  return pacificLocalToUTCISOString(target);
}

function getBusinessDaysFromNowAtPacific(daysToAdd, hour, minute) {
  const p = getPacificParts();

  let target = new Date(p.year, p.month - 1, p.day, hour, minute, 0, 0);
  let added = 0;

  while (added < daysToAdd) {
    target.setDate(target.getDate() + 1);
    const day = target.getDay();

    if (day !== 0 && day !== 6) {
      added += 1;
    }
  }

  return pacificLocalToUTCISOString(target);
}

function getNextRetryTime(attemptNumber) {

  if (attemptNumber === 1) {
    const retry = new Date();
    retry.setMinutes(retry.getMinutes() + 15);
    return retry.toISOString();
  }

  if (attemptNumber === 2) {
    const retry = new Date();
    retry.setHours(retry.getHours() + 2);
    return retry.toISOString();
  }

  if (attemptNumber === 3) {
    return getBusinessDaysFromNowAtPacific(1, 9, 0);
  }

  if (attemptNumber === 4) {
    return getBusinessDaysFromNowAtPacific(3, 10, 0);
  }

  if (attemptNumber === 5) {
    return getBusinessDaysFromNowAtPacific(7, 10, 0);
  }

  return '';
}
function determineCurrentAttempts(body) {
  return Number(body.auto_call_attempts || 0);
}

function determineAttempt(body) {
  if (body.attempt) return Number(body.attempt);

  const currentAttempts = determineCurrentAttempts(body);

  if (body.source === 'retry_call') {
    return currentAttempts + 1;
  }

  return currentAttempts > 0 ? currentAttempts : 1;
}

async function updateHubSpotContact(contactId, properties) {
  if (!HUBSPOT_TOKEN) {
    console.log('HubSpot update skipped: HUBSPOT_PRIVATE_APP_TOKEN missing.');
    return;
  }

  if (!contactId) {
    console.log('HubSpot update skipped: contactId missing.');
    return;
  }

  try {
    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
      { properties },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('HubSpot contact updated:', contactId, properties);
  } catch (err) {
    console.error('HubSpot contact update error:', err.response?.data || err.message);
  }
}

async function createHubSpotNote(contactId, noteBody) {
  if (!HUBSPOT_TOKEN || !contactId) return;

  try {
    await axios.post(
      'https://api.hubapi.com/crm/v3/objects/notes',
      {
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: Date.now()
        },
        associations: [
          {
            to: { id: contactId },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: 202
              }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('HubSpot note created for contact:', contactId);
  } catch (err) {
    console.error('HubSpot note creation error:', err.response?.data || err.message);
  }
}

async function sendProspectSMS(lead, message) {
  if (!lead?.phone) return;

  try {
    
    await client.messages.create({
      body: message,
      messagingServiceSid: process.env.MESSAGING_SERVICE_SID,
      to: lead.phone
    });

    console.log('Prospect SMS sent:', lead.phone);
  } catch (err) {
    console.error('Prospect SMS error:', err.message);
  }
}

async function sendProspectEmail(lead, subject, html) {
  if (!process.env.SENDGRID_API_KEY) return;
  if (!lead?.email) return;

  try {
    await sgMail.send({
      to: lead.email,
      from: EMAIL_FROM,
      subject,
      html
    });

    console.log('Prospect email sent:', lead.email);
  } catch (err) {
    console.error('Prospect email error:', err.response?.body || err.message);
  }
}

async function runTouchStep(lead) {
  const firstName = lead.firstname || 'there';

  // TOUCH 1
  if (lead.attemptNumber === 1) {

    await sendProspectSMS(
      lead,
      `Hi ${firstName}, this is Maximus Roofing. Thank you for requesting a roofing estimate. We just tried reaching you by phone and would be happy to schedule your complimentary roof assessment. Reply here or call us at 916-222-9729. Reply STOP to opt out.`
    );

    await sendProspectEmail(
      lead,
      'Complimentary Roof Assessment',
      `
      <p>Hi ${firstName},</p>
      <p>This is Maximus Roofing. We tried reaching you regarding your roofing inquiry.</p>
      <p>We offer complimentary roof assessments to help identify leaks, aging roof issues, and restoration opportunities before replacement becomes necessary.</p>
      <p>You can reply to this email or call us at <strong>916-222-9729</strong>.</p>
      <p>Thank you,<br>Maximus Roofing</p>
      `
    );
  }

  // TOUCH 3
  if (lead.attemptNumber === 3) {

    await sendProspectSMS(
      lead,
      `Hi ${firstName}, this is Maximus Roofing following up on your roofing inquiry. We'd still be happy to provide a complimentary roof assessment. Call 916-222-9729 or reply to this message. Reply STOP to opt out.`
    );

    await sendProspectEmail(
      lead,
      'Following Up on Your Roof Inquiry',
      `
      <p>Hi ${firstName},</p>
      <p>I wanted to follow up regarding your roof inquiry.</p>
      <p>Maximus Roofing specializes in flat roof restoration, leak prevention, and commercial roof assessments.</p>
      <p>If you are still interested, reply to this email or call us at <strong>916-222-9729</strong>.</p>
      <p>Thank you,<br>Maximus Roofing</p>
      `
    );
  }

  // TOUCH 5
  if (lead.attemptNumber === 5) {

    await sendProspectSMS(
      lead,
      `Final follow-up from Maximus Roofing. We can still help with a complimentary roof assessment. Reply here or call 916-222-9729. Reply STOP to opt out.`
    );
  }

  // TOUCH 6
  if (lead.attemptNumber === 6) {

    await sendProspectSMS(
      lead,
      `Last attempt from Maximus Roofing. If your roof project is still being considered, we'd be happy to help. Call 916-222-9729 or reply to this text. Reply STOP to opt out.`
    );

    await sendProspectEmail(
      lead,
      'Last Follow-Up Regarding Your Roof Project',
      `
      <p>Hi ${firstName},</p>

      <p>This is our final follow-up regarding your roofing inquiry.</p>

      <p>Maximus Roofing specializes in commercial flat roof restoration, roof coatings, leak repair, inspections, and preventative maintenance throughout Northern California.</p>

      <p>If your project is still active, simply reply to this email or call us at <strong>916-222-9729</strong>.</p>

      <p>We would be happy to provide a complimentary roof assessment.</p>

      <p>Thank you,<br>Maximus Roofing</p>
      `
    );
  }
}
async function markCallResult(lead, status) {
  if (!lead) return;

  lead.status = status;

  const properties = {
    auto_call_status: status
  };

  if (
    status === 'no-answer' ||
    status === 'busy' ||
    status === 'failed' ||
    status === 'voicemail'
  ) {
    properties.hs_lead_status = 'ATTEMPTED_TO_CONTACT';
    properties.auto_call_attempts = String(lead.attemptNumber);
    await runTouchStep(lead);

    const nextRetry = getNextRetryTime(lead.attemptNumber);

    if (nextRetry) {
  properties.next_call_attempt = nextRetry;
  properties.auto_sequence_status = 'Active';
  lead.nextCallAttempt = nextRetry;
} else {
  properties.auto_call_status = 'max_attempts_reached';
  properties.auto_sequence_status = 'Stopped';
  properties.next_call_attempt = '';
  lead.status = 'max_attempts_reached';
  lead.nextCallAttempt = '';
}
  }

  if (status === 'answered' || status === 'connected') {
    properties.auto_call_status = 'answered';
    properties.auto_sequence_status = 'Engaged';
    properties.hs_lead_status = 'CONNECTED';
    properties.auto_call_attempts = String(lead.attemptNumber);
    properties.next_call_attempt = '';
    properties.auto_call_eligible = 'No';
    lead.nextCallAttempt = '';
  }

  await updateHubSpotContact(lead.contactId, properties);
}

async function startLeadCall(reqBody, sourceType) {
  console.log(`${sourceType} webhook body:`, JSON.stringify(reqBody, null, 2));

  console.log('Pacific time now:', getPacificDate());
  console.log('Pacific parts:', getPacificParts());
  console.log('Business hours?', isBusinessHoursPacific());

  const rawPhone = extractPhone(reqBody);
const phone = formatPhone(rawPhone);

const contactId =
  reqBody.contactId ||
  reqBody.hs_object_id ||
  reqBody.objectId ||
  reqBody.recordId ||
  '';

if (!phone) {
  await updateHubSpotContact(contactId, {
    auto_call_status: 'invalid_phone',
    auto_sequence_status: 'Stopped',
    next_call_attempt: ''
  });

  console.log(
    `[SKIPPED] Contact ${contactId || 'unknown'} - invalid phone: ${rawPhone}`
  );

  return {
    success: true,
    skipped: true,
    reason: 'Invalid phone number'
  };
}

  
  if (shouldStopSequence(reqBody)) {
  await updateHubSpotContact(contactId, {
    next_call_attempt: '',
    auto_call_status: 'sequence_stopped'
  });

  return {
    success: true,
    message: 'Sequence already stopped or lead already engaged. No call placed.'
  };
}

  const currentAttempts = determineCurrentAttempts(reqBody);
  const attemptNumber = determineAttempt(reqBody);

  if (attemptNumber > MAX_CALL_ATTEMPTS) {
    await updateHubSpotContact(contactId, {
      auto_call_status: 'max_attempts_reached',
      auto_call_attempts: String(currentAttempts),
      next_call_attempt: ''
    });

    return {
      success: true,
      message: 'Max attempts reached. No call placed.'
    };
  }

  if (!isBusinessHoursPacific()) {
    const nextBusinessMorning = getNextBusinessMorningPacific(9, 0);

    await updateHubSpotContact(contactId, {
      auto_call_attempts: String(attemptNumber),
      auto_call_status: 'after_hours_scheduled',
      next_call_attempt: nextBusinessMorning,
      hs_lead_status: 'ATTEMPTED_TO_CONTACT'
    });

    const queuedLead = {
      contactId,
      firstname: reqBody.firstname || reqBody.firstName || '',
      lastname: reqBody.lastname || reqBody.lastName || '',
      email: reqBody.email || '',
      phone,
      source: reqBody.source || sourceType,
      attemptNumber: attemptNumber,
      status: 'after_hours_scheduled',
      createdAt: new Date().toISOString(),
      callSid: '',
      recordingUrl: '',
      nextCallAttempt: nextBusinessMorning
    };

    callbackQueue.unshift(queuedLead);

    console.log('Outside business hours. Scheduled for:', nextBusinessMorning);

    return {
      success: true,
      message: 'Outside business hours. Lead scheduled for next business day 8:00 AM Pacific.',
      scheduledFor: nextBusinessMorning,
      lead: queuedLead
    };
  }

  const lead = {
    contactId,
    firstname: reqBody.firstname || reqBody.firstName || '',
    lastname: reqBody.lastname || reqBody.lastName || '',
    email: reqBody.email || '',
    phone,
    source: reqBody.source || sourceType,
    attemptNumber,
    status: `attempt_${attemptNumber}_started`,
    createdAt: new Date().toISOString(),
    callSid: '',
    recordingUrl: '',
    nextCallAttempt: ''
  };

  callbackQueue.unshift(lead);

  await updateHubSpotContact(lead.contactId, {
  auto_call_attempts: String(attemptNumber),
  auto_call_status: `attempt_${attemptNumber}_started`,
  auto_sequence_status: 'Active',
  next_call_attempt: '',
  twilio_call_sid: '',
  hs_lead_status: 'ATTEMPTED_TO_CONTACT'
});

  setTimeout(async () => {
    try {
      const call = await client.calls.create({
        to: phone,
        from: process.env.TWILIO_NUMBER,
        url: `${BASE_URL}/voice`,
        method: 'POST',
        statusCallback: `${BASE_URL}/call-status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        machineDetection: 'Enable',
        machineDetectionTimeout: 30
      });

      lead.callSid = call.sid;
      lead.status = `attempt_${attemptNumber}_call_started`;

      callMap[call.sid] = lead;

      await updateHubSpotContact(lead.contactId, {
        twilio_call_sid: call.sid,
        auto_call_status: `attempt_${attemptNumber}_call_started`,
        auto_call_attempts: String(attemptNumber),
        hs_lead_status: 'ATTEMPTED_TO_CONTACT'
      });

      console.log('Call started to:', phone);
      console.log('Call SID:', call.sid);
    } catch (err) {
      lead.status = 'failed';
      console.error('Twilio call error:', err.message);

      await markCallResult(lead, 'failed');
    }
  }, 10000);

  return {
    success: true,
    message: `Attempt ${attemptNumber} received. Call will start in 10 seconds.`,
    lead
  };
}

app.get('/', (req, res) => {
  res.status(200).send('Maximus Twilio server is running');
});

app.get('/business-hours-test', (req, res) => {
  res.json({
    pacificTime: getPacificDate(),
    pacificParts: getPacificParts(),
    isBusinessHours: isBusinessHoursPacific(),
    rule: 'Monday-Friday, 8:00 AM - 6:00 PM Pacific'
  });
});

app.post('/new-lead', async (req, res) => {
  const result = await startLeadCall(req.body, req.body.source || 'hubspot_auto');
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/manual-call', async (req, res) => {
  const result = await startLeadCall(req.body, 'hubspot_manual');
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/voice', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const answeredBy = req.body.AnsweredBy;
  const callSid = req.body.CallSid;
  const lead = callMap[callSid];

  console.log('AnsweredBy:', answeredBy);
  console.log('Voice CallSid:', callSid);

  const isMachine =
    answeredBy === 'machine_start' ||
    answeredBy === 'machine_end_beep' ||
    answeredBy === 'machine_end_silence' ||
    answeredBy === 'machine_end_other' ||
    answeredBy === 'fax';

  if (!isMachine) {
    if (lead) {
      await markCallResult(lead, 'answered');
    }

    twiml.say('Please hold while we connect you with Maximus Roofing.');

    const leadName = encodeURIComponent(
      `${lead?.firstname || ''} ${lead?.lastname || ''}`.trim()
    );

    const dial = twiml.dial({
      answerOnBridge: true,
      timeout: 12,
      callerId: lead?.phone || process.env.TWILIO_NUMBER,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${BASE_URL}/recording-complete`,
      recordingStatusCallbackMethod: 'POST'
    });

    dial.number(
      {
        url: `${BASE_URL}/agent-whisper?leadName=${leadName}`,
        method: 'POST'
      },
      MAXIMUS_PHONE
    );

    twiml.say('Our team is unavailable at the moment. We will call you back shortly.');
    twiml.hangup();
  } else {
  console.log('Machine detected. Leaving voicemail.');

  if (lead) {
    await markCallResult(lead, 'voicemail');
  }

  twiml.say(
    { voice: 'alice' },
    'Hi, this is Maximus Roofing. Thank you for requesting a roofing estimate. We just tried reaching you regarding your request. Please call us back at 916-222-9729 or reply to our text message. We look forward to speaking with you.'
  );

  twiml.hangup();
}

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/agent-whisper', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const leadName = req.query.leadName || '';

  if (leadName) {
    twiml.say(`New marketing lead from HubSpot. ${leadName}. Connecting now.`);
  } else {
    twiml.say('New marketing lead from HubSpot. Connecting now.');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  console.log('Call status:', callSid, callStatus);

  const lead = callMap[callSid];

  if (!lead) {
    console.log('No lead found for CallSid:', callSid);
    return res.status(200).send('OK');
  }

  lead.twilioStatus = callStatus;

  if (callStatus === 'no-answer') {
    await markCallResult(lead, 'no-answer');
  }

  if (callStatus === 'busy') {
    await markCallResult(lead, 'busy');
  }

  if (callStatus === 'failed') {
    await markCallResult(lead, 'failed');
  }

  if (callStatus === 'canceled') {
    await markCallResult(lead, 'failed');
  }

  res.status(200).send('OK');
});

app.post('/recording-complete', async (req, res) => {
  try {
    console.log('Recording callback body:', JSON.stringify(req.body, null, 2));

    const callSid = req.body.CallSid;
    const recordingSid = req.body.RecordingSid || '';
    const recordingDuration = req.body.RecordingDuration || '';
    const recordingUrl = req.body.RecordingUrl
      ? `${req.body.RecordingUrl}.mp3`
      : '';

    if (!recordingUrl) {
      console.log('No recording URL received');
      return res.status(200).send('No recording URL');
    }

    const lead = callMap[callSid];

    if (lead) {
      lead.recordingUrl = recordingUrl;
      lead.status = 'recording_completed';

      await updateHubSpotContact(lead.contactId, {
  twilio_recording_url: recordingUrl,
  twilio_call_sid: callSid,
  auto_call_status: 'answered',
  auto_sequence_status: 'Engaged',
  auto_call_attempts: String(lead.attemptNumber),
  next_call_attempt: '',
  hs_lead_status: 'CONNECTED'
});

      await createHubSpotNote(
        lead.contactId,
        `
          <p><strong>Twilio call recording completed</strong></p>
          <p><strong>Lead:</strong> ${lead.firstname || ''} ${lead.lastname || ''}</p>
          <p><strong>Phone:</strong> ${lead.phone || ''}</p>
          <p><strong>Attempt:</strong> ${lead.attemptNumber || ''}</p>
          <p><strong>Call SID:</strong> ${callSid}</p>
          <p><strong>Recording SID:</strong> ${recordingSid}</p>
          <p><strong>Duration:</strong> ${recordingDuration} seconds</p>
          <p><a href="${recordingUrl}" target="_blank">Open Call Recording</a></p>
        `
      );
    }

    console.log('Recording URL:', recordingUrl);

    res.status(200).send('OK');
  } catch (err) {
    console.error('Recording callback error:', err.message);
    res.status(500).send('Recording callback error');
  }
});

app.post('/sms-reply', async (req, res) => {
  try {
    const from = formatPhone(req.body.From);
    const body = req.body.Body || '';

    console.log('SMS reply received:', from, body);

    await createHubSpotNote(
      req.body.contactId,
      `
        <p><strong>SMS reply received</strong></p>
        <p><strong>From:</strong> ${from || ''}</p>
        <p><strong>Message:</strong> ${body}</p>
      `
    );

    // HubSpot contact ID is not available from Twilio SMS by default.
    // Make Scenario should search HubSpot by phone and update:
    // sms_replied = Yes
    // auto_sequence_status = Engaged
    // next_call_attempt = empty

    res.status(200).send('OK');
  } catch (err) {
    console.error('SMS reply endpoint error:', err.message);
    res.status(500).send('SMS reply error');
  }
});

app.post('/email-reply', async (req, res) => {
  try {
    const contactId = req.body.contactId || '';

    await updateHubSpotContact(contactId, {
      email_replied: 'Yes',
      auto_sequence_status: 'Engaged',
      auto_call_status: 'email_replied',
      next_call_attempt: ''
    });

    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

app.post('/incoming-call', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say('Thank you for calling Maximus Roofing. Please hold while we connect you.');

  const dial = twiml.dial({
    answerOnBridge: true,
    timeout: 20
  });

  dial.number(MAXIMUS_PHONE);

  twiml.say('Our team is unavailable at the moment. Please call again shortly or wait for our callback.');
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

app.get('/operator', (req, res) => {
  const rows = callbackQueue.map((lead, index) => {
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${lead.createdAt || ''}</td>
        <td>${lead.firstname || ''} ${lead.lastname || ''}</td>
        <td><a href="tel:${lead.phone}">${lead.phone || ''}</a></td>
        <td>${lead.email || ''}</td>
        <td>${lead.source || ''}</td>
        <td>${lead.attemptNumber || ''}</td>
        <td>${lead.status || ''}</td>
        <td>${lead.nextCallAttempt || ''}</td>
        <td>${lead.contactId || ''}</td>
        <td>
          ${
            lead.recordingUrl
              ? `<a href="${lead.recordingUrl}" target="_blank">Recording</a>`
              : ''
          }
        </td>
      </tr>
    `;
  }).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Maximus Callback Queue</title>
        <meta http-equiv="refresh" content="15">
        <style>
          body {
            font-family: Arial, sans-serif;
            padding: 24px;
            background: #f7f7f7;
          }
          table {
            border-collapse: collapse;
            width: 100%;
            background: white;
          }
          th, td {
            border: 1px solid #ddd;
            padding: 10px;
            text-align: left;
          }
          th {
            background: #1f3a5f;
            color: white;
          }
          tr:nth-child(even) {
            background: #f2f2f2;
          }
          a {
            color: #0066cc;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <h2>Maximus Roofing Callback Queue</h2>
        <p>This page auto-refreshes every 15 seconds.</p>

        <table>
          <tr>
            <th>#</th>
            <th>Created</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Source</th>
            <th>Attempt</th>
            <th>Status</th>
            <th>Next Retry</th>
            <th>HubSpot Contact ID</th>
            <th>Recording</th>
          </tr>
          ${rows}
        </table>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
