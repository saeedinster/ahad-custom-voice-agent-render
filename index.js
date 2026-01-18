require('dotenv').config();
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI = require('openai');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: true }));

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const n8nWebhook = process.env.N8N_WEBHOOK;

// Memory per call (like Retell context)
const conversationMemory = {};

app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';

  if (!conversationMemory[callSid]) {
    conversationMemory[callSid] = {
      step: 'greeting',
      previous_client: null,
      skip_referral: false,
      referral_source: null,
      call_reason: null,
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      booking_completed: false
    };
  }
  const memory = conversationMemory[callSid];

  // OpenAI logic (follows your YML exactly)
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `You are a friendly CPA receptionist for Ahad and Co CPA Firm. Follow this flow exactly like Retell YML:

      1. Greet: "Thanks for calling Ahad and Co CPA Firm. How can I help you today?" (speak naturally)

      2. Handle intents:
         - If user says "personal tax", "individual tax", "business tax", "business accounting", "tax info", "tax consultation", "tax help" — offer free 15-min consultation: "We can help. Let's schedule a free 15-minute consultation. Would you like to book?" (yes → booking, no → message)

      3. Collect info slowly:
         - First name: "May I have your first name? Please spell it out slowly and clearly."
         - Last name: same
         - Email: "What is your email address? Please spell it out very slowly, one letter at a time, pause after each letter." Then repeat full email slowly: "Let me repeat slowly: [spell with pauses]. Is this correct?"
         - Phone: "And your phone number?"
         - Previous client: "Have you used Ahad and Co before?" (only ask once, remember answer)
         - Referral: "How did you hear about us?" (skip if previous_client = Yes)
         - Call reason: "What's the main reason for your call?"

      4. Book appointment if user says yes to booking.

      5. Send to n8n on booking.

      6. End with one "Goodbye" — no repeats.

      Remember context: previous_client, referral_source, names, email, phone, reason. Speak slowly for spelling. Never repeat questions once answered.` },
      { role: "user", content: userSpeech || "start" },
      { role: "assistant", content: `Current memory: ${JSON.stringify(memory)}` }
    ],
  });
  let agentText = completion.choices[0].message.content.trim();

  // Update memory from LLM response (parse key info)
  if (agentText.toLowerCase().includes("previous client") || agentText.toLowerCase().includes("returning")) {
    memory.previous_client = agentText.includes("Yes") ? "Yes" : "No";
    if (memory.previous_client === "Yes") memory.skip_referral = true;
  }
  if (agentText.toLowerCase().includes("referral")) {
    memory.referral_source = agentText.match(/referral:?\s*(.*)/i)?.[1] || null;
  }
  if (agentText.toLowerCase().includes("first name")) memory.first_name = agentText.match(/first name:?\s*(.*)/i)?.[1] || null;
  if (agentText.toLowerCase().includes("last name")) memory.last_name = agentText.match(/last name:?\s*(.*)/i)?.[1] || null;
  if (agentText.toLowerCase().includes("email")) memory.email = agentText.match(/email:?\s*(.*)/i)?.[1] || null;
  if (agentText.toLowerCase().includes("phone")) memory.phone = agentText.match(/phone:?\s*(.*)/i)?.[1] || null;
  if (agentText.toLowerCase().includes("reason")) memory.call_reason = agentText.match(/reason:?\s*(.*)/i)?.[1] || null;

  // ElevenLabs TTS (Grace voice, slow & clear for spelling)
  const audioStream = await elevenlabs.generate({
    voice: process.env.ELEVENLABS_VOICE_ID,
    text: agentText,
    model_id: "eleven_multilingual_v2",
    optimize_streaming_latency: 1, // Faster
  });

  // Twilio <Play> (use public URL from ElevenLabs stream)
  twiml.play({ url: audioStream.url });

  // Send to n8n if booked
  if (agentText.toLowerCase().includes("booked") || agentText.toLowerCase().includes("appointment is booked")) {
    await axios.post(n8nWebhook, {
      type: "appointment_booking",
      first_name: memory.first_name || "Unknown",
      last_name: memory.last_name || "Unknown",
      phone: memory.phone || req.body.From,
      email_address: memory.email || "unknown@example.com",
      selected_slot: "2026-01-20T11:00:00", // Replace with real slot from LLM later
      call_reason: memory.call_reason || "Tax consultation",
      referral_source: memory.referral_source || "Unknown",
      previous_client: memory.previous_client || "No",
      summary: agentText,
      timestamp: new Date().toISOString(),
      booking_status: "confirmed"
    });
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
