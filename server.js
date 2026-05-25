require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

const BASE_URL = 'https://maximus-calls.onrender.com';
const MAXIMUS_PHONE = '+19162229729';

app.get('/', (req, res) => {
  res.status(200).send('Maximus Twilio server is running');
});

app.post('/new-lead', async (req, res) => {
  console.log('Full HubSpot body:', JSON.stringify(req.body, null, 2));

  // Always answer HubSpot immediately
  res.status(200).json({
    success: true,
    message: 'Webhook received'
  });

  let phone =
    req.body.phone ||
    req.body.properties?.phone ||
    req.body.phone_number;

  if (!phone) {
    console.log('No phone number received from HubSpot');
    return;
  }

  phone = String(phone).replace(/\D/g, '');

  if (phone.length === 10) {
    phone = '+1' + phone;
  } else if (phone.length === 11 && phone.startsWith('1')) {
    phone = '+' + phone;
  } else {
    console.log('Invalid phone format:', phone);
    return;
  }

  console.log('Formatted lead phone:', phone);

  setTimeout(async () => {
    try {
      await client.calls.create({
        to: phone,
        from: process.env.TWILIO_NUMBER,
        url: `${BASE_URL}/voice`,
        method: 'POST',
        machineDetection: 'Enable',
        asyncAmd: true,
        asyncAmdStatusCallback: `${BASE_URL}/amd`,
        asyncAmdStatusCallbackMethod: 'POST'
      });

      console.log('Call started to:', phone);
    } catch (err) {
      console.error('Call error:', err.message);
    }
  }, 10000);
});

app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say('Hello, this is Maximus Roofing.');
  twiml.pause({ length: 2 });
  twiml.say('Please hold while we connect you.');

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/amd', async (req, res) => {
  const answeredBy = req.body.AnsweredBy;
  const callSid = req.body.CallSid;

  console.log('AMD Result:', answeredBy);
  console.log('Call SID:', callSid);

  try {
    if (answeredBy === 'human') {
      await client.calls(callSid).update({
        url: `${BASE_URL}/connect`,
        method: 'POST'
      });

      console.log('Human detected. Connecting call.');
    } else {
      await client.calls(callSid).update({
        twiml: '<Response><Hangup/></Response>'
      });

      console.log('Voicemail or machine detected. Hanging up.');
    }
  } catch (err) {
    console.error('AMD update error:', err.message);
  }

  res.sendStatus(200);
});

app.post('/connect', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say('Please hold while we connect you with Maximus Roofing.');
  twiml.dial(MAXIMUS_PHONE);

  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
