require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const axios = require('axios');

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

let callbackQueue = [];
let callMap = {};

function formatPhone(rawPhone) {
  if (!rawPhone) return null;

  let phone = String(rawPhone).replace(/\D/g, '');

  if (phone.length === 10) return '+1' + phone;
  if (phone.length === 11 && phone.startsWith('1')) return '+' + phone;
  if (String(rawPhone).startsWith('+')) return String(rawPhone);

  return null;
}

function extractPhone(body) {
  return (
    body.phone ||
    body.mobilephone ||
    body.properties?.phone ||
    body.properties?.mobilephone ||
    body.phone_number
  );
}

function determineAttempt(body) {
  if (body.attempt) return Number(body.attempt);

  const currentAttempts = Number(body.auto_call_attempts || 0);

  if (body.source === 'retry_call') {
    return currentAttempts + 1;
  }

  return currentAttempts > 0 ? currentAttempts : 1;
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

function getNextBusinessDayAtPacific(hour, minute) {
  const now = new Date();

  const pacificNowString = now.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles'
  });

  const pacificNow = new Date(pacificNowString);

  let target = new Date(pacificNow);
  target.setDate(target.getDate() + 1);
  target.setHours(hour, minute, 0, 0);

  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }

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

function getNextRetryTime(attemptNumber) {
  if (attemptNumber === 1) {
    const retry = new Date();
    retry.setHours(retry.getHours() + 2);
    return retry.toISOString();
  }

  if (attemptNumber === 2) {
    return getNextBusinessDayAtPacific(9, 0);
  }

  return '';
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
    console.error(
      'HubSpot contact update error:',
      err.response?.data || err.message
    );
  }
}

async function createHubSpotNote(contactId, noteBody) {
  if (!HUBSPOT_TOKEN || !contactId) return;

  try {
    const timestamp = Date.now();

    await axios.post(
      'https://api.hubapi.com/crm/v3/objects/notes',
      {
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: timestamp
        },
        associations: [
          {
            to: {
              id: contactId
            },
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
    console.error(
      'HubSpot note creation error:',
      err.response?.data || err.message
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

    const nextRetry = getNextRetryTime(lead.attemptNumber);

    properties.auto_call_attempts = String(lead.attemptNumber);
    properties.next_call_attempt = nextRetry;

    lead.nextCallAttempt = nextRetry;
  }

  if (status === 'answered' || status === 'connected') {
    properties.auto_call_status = 'answered';
    properties.hs_lead_status = 'CONNECTED';
    properties.auto_call_attempts = String(lead.attemptNumber);
    properties.next_call_attempt = '';
  }

  await updateHubSpotContact(lead.contactId, properties);
}

async function startLeadCall(reqBody, sourceType) {
  console.log(`${sourceType} webhook body:`, JSON.stringify(reqBody, null, 2));

  const rawPhone = extractPhone(reqBody);
  const phone = formatPhone(rawPhone);

  if (!phone) {
    console.log('No valid phone received:', rawPhone);
    return {
      success: false,
      error: 'No valid phone received'
    };
  }

  const attemptNumber = determineAttempt(reqBody);

  const lead = {
    contactId:
      reqBody.contactId ||
      reqBody.hs_object_id ||
      reqBody.objectId ||
      reqBody.recordId ||
      '',
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

  if (answeredBy === 'human') {
    if (lead) {
      await markCallResult(lead, 'answered');
    }

    twiml.say('This call may be recorded for quality and training purposes.');
    twiml.say('Please hold while we connect you with Maximus Roofing.');

    const dial = twiml.dial({
      answerOnBridge: true,
      timeout: 12,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${BASE_URL}/recording-complete`,
      recordingStatusCallbackMethod: 'POST'
    });

    dial.number(MAXIMUS_PHONE);

    twiml.say('Our team is unavailable at the moment. We will call you back shortly.');
    twiml.hangup();
  } else {
    console.log('Machine, voicemail, or unknown detected. Hanging up.');

    if (lead) {
      await markCallResult(lead, 'voicemail');
    }

    twiml.hangup();
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
