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

let callbackQueue = [];
let callMap = {};

function formatPhone(rawPhone) {
  if (!rawPhone) return null;

  let phone = String(rawPhone).replace(/\D/g, '');

  if (phone.length === 10) {
    return '+1' + phone;
  }

  if (phone.length === 11 && phone.startsWith('1')) {
    return '+' + phone;
  }

  if (String(rawPhone).startsWith('+')) {
    return String(rawPhone);
  }

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

  const lead = {
    contactId: reqBody.contactId || reqBody.hs_object_id || reqBody.objectId || '',
    firstname: reqBody.firstname || reqBody.firstName || '',
    lastname: reqBody.lastname || reqBody.lastName || '',
    email: reqBody.email || '',
    phone,
    source: reqBody.source || sourceType,
    status: sourceType === 'hubspot_manual' ? 'Manual call requested' : 'New lead call requested',
    createdAt: new Date().toISOString(),
    callSid: ''
  };

  callbackQueue.unshift(lead);

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

        // Synchronous AMD
        machineDetection: 'Enable',
        machineDetectionTimeout: 30
      });

      lead.callSid = call.sid;
      lead.status = 'Twilio call started';

      callMap[call.sid] = lead;

      console.log('Call started to:', phone);
      console.log('Call SID:', call.sid);
    } catch (err) {
      lead.status = 'Twilio call error';
      console.error('Twilio call error:', err.message);
    }
  }, 10000);

  return {
    success: true,
    message: 'Webhook received. Call will start in 10 seconds.',
    lead
  };
}

app.get('/', (req, res) => {
  res.status(200).send('Maximus Twilio server is running');
});

app.post('/new-lead', async (req, res) => {
  const result = await startLeadCall(req.body, 'hubspot_auto');
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/manual-call', async (req, res) => {
  const result = await startLeadCall(req.body, 'hubspot_manual');
  res.status(result.success ? 200 : 400).json(result);
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const answeredBy = req.body.AnsweredBy;

  console.log('AnsweredBy:', answeredBy);

  if (answeredBy === 'human' || answeredBy === 'unknown') {
    twiml.say('This call may be recorded for quality and training purposes.');
    twiml.say('Please hold while we connect you with Maximus Roofing.');

    const dial = twiml.dial({
      answerOnBridge: true,
      timeout: 25,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${BASE_URL}/recording-complete`,
      recordingStatusCallbackMethod: 'POST'
    });

    dial.number(MAXIMUS_PHONE);
  } else {
    console.log('Machine or voicemail detected. Hanging up.');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/call-status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  console.log('Call status:', callSid, callStatus);

  if (callSid && callMap[callSid]) {
    callMap[callSid].status = `Call ${callStatus}`;
  }

  res.status(200).send('OK');
});

app.post('/recording-complete', async (req, res) => {
  try {
    console.log('Recording callback body:', JSON.stringify(req.body, null, 2));

    const callSid = req.body.CallSid;
    const recordingUrl = req.body.RecordingUrl ? `${req.body.RecordingUrl}.mp3` : '';

    if (!recordingUrl) {
      console.log('No recording URL received');
      return res.status(200).send('No recording URL');
    }

    const lead = callMap[callSid];

    if (lead) {
      lead.recordingUrl = recordingUrl;
      lead.status = 'Recording completed';
    }

    console.log('Recording URL:', recordingUrl);

    if (lead && lead.contactId && process.env.HUBSPOT_PRIVATE_APP_TOKEN) {
      await updateHubSpotContactWithRecording(lead.contactId, recordingUrl, callSid);
    } else {
      console.log('HubSpot update skipped. Missing contactId or HUBSPOT_PRIVATE_APP_TOKEN.');
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Recording callback error:', err.message);
    res.status(500).send('Recording callback error');
  }
});

async function updateHubSpotContactWithRecording(contactId, recordingUrl, callSid) {
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;

    await axios.patch(
      url,
      {
        properties: {
          twilio_recording_url: recordingUrl,
          twilio_call_sid: callSid,
          auto_call_status: 'Recording completed'
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('HubSpot contact updated with recording URL:', contactId);
  } catch (err) {
    console.error('HubSpot contact update error:', err.response?.data || err.message);
  }
}

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
        <td>${lead.status || ''}</td>
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
          h2 {
            margin-bottom: 8px;
          }
          p {
            color: #555;
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
            <th>Status</th>
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
