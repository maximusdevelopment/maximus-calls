require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

const BASE_URL = 'https://maximus-calls.onrender.com';
const MAXIMUS_PHONE = '+19162229729';

// Health check
app.get('/', (req, res) => {
  res.send('Maximus Twilio server is running');
});

// 1. HUBSPOT WEBHOOK ENTRY
app.post('/new-lead', async (req, res) => {
  const phone = req.body.phone || req.body.properties?.phone;

  console.log('New lead phone:', phone);

  if (!phone) {
    return res.status(400).send('Missing phone number');
  }

  res.sendStatus(200);

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

// 2. INITIAL CALL HANDLER
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say('Hello, this is Maximus Roofing.');
  twiml.pause({ length: 2 });
  twiml.say('Please hold while we connect you.');

  res.type('text/xml');
  res.send(twiml.toString());
});

// 3. AMD RESULT HANDLER
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
    } else {
      await client.calls(callSid).update({
        twiml: '<Response><Hangup/></Response>'
      });
    }
  } catch (err) {
    console.error('AMD update error:', err.message);
  }

  res.sendStatus(200);
});

// 4. CONNECT WITH CONFIRMATION
app.post('/connect', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    numDigits: 1,
    timeout: 5,
    action: '/confirm',
    method: 'POST'
  });

  gather.say('Press 1 to connect with our roofing specialist.');

  twiml.say('We did not receive your response. Goodbye.');
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// 5. FINAL CONNECTION
app.post('/confirm', (req, res) => {
  const digit = req.body.Digits;
  const twiml = new twilio.twiml.VoiceResponse();

  if (digit === '1') {
    twiml.say('Connecting you now.');
    twiml.dial(MAXIMUS_PHONE);
  } else {
    twiml.say('Thank you. Goodbye.');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
