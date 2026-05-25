require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// =============================
// 1. HUBSPOT WEBHOOK ENTRY
// =============================
app.post('/new-lead', async (req, res) => {
  const phone = req.body.phone;

  console.log("New lead:", phone);

  setTimeout(async () => {
    try {
      await client.calls.create({
        to: phone,
        from: process.env.TWILIO_NUMBER,
        url: 'https://YOUR-RENDER-URL.onrender.com/voice',

        // ✅ HUMAN DETECTION
        machineDetection: "Enable",
        asyncAmd: true,
        asyncAmdStatusCallback: "https://YOUR-RENDER-URL.onrender.com/amd"
      });
    } catch (err) {
      console.error(err);
    }
  }, 10000); // 10 sec delay

  res.sendStatus(200);
});

// =============================
// 2. INITIAL CALL HANDLER
// =============================
app.post('/voice', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  // ⏳ buffer while AMD runs
  twiml.say("Hello, this is Maximus Roofing.");
  twiml.pause({ length: 3 });
  twiml.say("Please hold while we connect you.");

  res.type('text/xml');
  res.send(twiml.toString());
});

// =============================
// 3. AMD RESULT HANDLER
// =============================
app.post('/amd', async (req, res) => {
  const answeredBy = req.body.AnsweredBy;
  const callSid = req.body.CallSid;

  console.log("AMD Result:", answeredBy);

  try {
    if (answeredBy === "human") {
      // ✅ HUMAN → CONTINUE FLOW
      await client.calls(callSid).update({
        url: "https://YOUR-RENDER-URL.onrender.com/connect"
      });
    } else {
      // ❌ VOICEMAIL → HANG UP
      await client.calls(callSid).update({
        twiml: "<Response><Hangup/></Response>"
      });
    }
  } catch (err) {
    console.error(err);
  }

  res.sendStatus(200);
});

// =============================
// 4. CONNECT (WITH CONFIRMATION)
// =============================
app.post('/connect', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  // 🔥 HUMAN CONFIRMATION (BEST PRACTICE)
  twiml.gather({
    numDigits: 1,
    timeout: 5,
    action: '/confirm'
  });

  twiml.say("Press 1 to connect with our roofing specialist.");

  res.type('text/xml');
  res.send(twiml.toString());
});

// =============================
// 5. FINAL CONNECTION
// =============================
app.post('/confirm', (req, res) => {
  const digit = req.body.Digits;

  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  if (digit === "1") {
    twiml.say("Connecting you now.");
    twiml.dial('+19162229729');
  } else {
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
