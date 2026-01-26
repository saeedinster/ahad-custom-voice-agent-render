require('dotenv').config();
const express = require('express');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI = require('openai');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check endpoint for Render
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Ahad CPA Voice Agent is running' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const n8nWebhook = process.env.N8N_WEBHOOK_URL || 'https://scottde.app.n8n.cloud/webhook/TestAhadCPA';

// Cal.com Configuration
const calComApiKey = process.env.CALCOM_API_KEY;
const calComEventTypeId = process.env.CALCOM_EVENT_TYPE_ID;
const calComTimezone = process.env.CALCOM_TIMEZONE || 'America/New_York';

// ===== HELPER FUNCTIONS =====

// Cal.com: Get available slots for next 2 weeks
async function getCalendarAvailability(startDate, endDate, preferredTime = null) {
  if (!calComApiKey || !calComEventTypeId) {
    console.log('Cal.com not configured, returning mock slots');
    return null;
  }

  try {
    const params = new URLSearchParams({
      apiKey: calComApiKey,
      eventTypeId: calComEventTypeId,
      startTime: startDate.toISOString(),
      endTime: endDate.toISOString(),
      timeZone: calComTimezone
    });

    const response = await axios.get(
      `https://api.cal.com/v1/availability?${params.toString()}`,
      { timeout: 10000 }
    );

    const slots = response.data?.slots || [];

    // Return top 3-5 slots formatted for conversation
    return slots.slice(0, 5).map(slot => ({
      start: new Date(slot.time),
      end: new Date(new Date(slot.time).getTime() + 60 * 60 * 1000), // Assume 1hr
      iso: slot.time,
      displayText: formatSlotForSpeech(new Date(slot.time))
    }));
  } catch (error) {
    console.error('Cal.com API error:', error.message);
    return null;
  }
}

// Format date for natural speech
function formatSlotForSpeech(date) {
  const options = {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: calComTimezone
  };
  return date.toLocaleDateString('en-US', options);
}

// Cal.com: Create booking
async function createCalComBooking(slotISO, userInfo) {
  if (!calComApiKey || !calComEventTypeId) {
    console.log('Cal.com not configured, skipping booking creation');
    return null;
  }

  try {
    const response = await axios.post(
      `https://api.cal.com/v1/bookings?apiKey=${calComApiKey}`,
      {
        eventTypeId: parseInt(calComEventTypeId),
        start: slotISO,
        responses: {
          name: `${userInfo.first_name} ${userInfo.last_name}`,
          email: userInfo.email,
          phone: userInfo.phone,
          notes: userInfo.call_reason || ''
        },
        timeZone: calComTimezone,
        language: 'en'
      },
      { timeout: 10000 }
    );

    console.log('Cal.com booking created:', response.data?.id);
    return response.data;
  } catch (error) {
    console.error('Cal.com booking error:', error.message);
    return null;
  }
}

// Detect slot acceptance from user speech
function detectSlotAcceptance(speech, offeredSlots) {
  if (!offeredSlots || offeredSlots.length === 0) return null;

  const lower = speech.toLowerCase();

  // Check for specific slot selection
  if (/(first|1|one)/i.test(lower) && offeredSlots[0]) return offeredSlots[0];
  if (/(second|2|two)/i.test(lower) && offeredSlots[1]) return offeredSlots[1];
  if (/(third|3|three)/i.test(lower) && offeredSlots[2]) return offeredSlots[2];
  if (/(fourth|4|four)/i.test(lower) && offeredSlots[3]) return offeredSlots[3];
  if (/(fifth|5|five)/i.test(lower) && offeredSlots[4]) return offeredSlots[4];

  // Generic acceptance - default to first slot
  if (/^(yes|yeah|sure|ok|okay|that works|sounds good|perfect)/i.test(lower.trim())) {
    return offeredSlots[0];
  }

  return null;
}

// Intent detection using keywords (fallback)
function detectIntentByKeywords(speech) {
  const lower = speech.toLowerCase();

  // Speak to person patterns
  if (/(speak|talk) (to|with)|someone|person|representative|human/i.test(lower)) {
    return 'speak_to_person';
  }

  // Appointment patterns
  if (/appointment|book|schedule|available|meeting|consultation|slot|time/i.test(lower)) {
    return 'appointment';
  }

  // Message patterns
  if (/message|call back|leave.*message|voice.*mail/i.test(lower)) {
    return 'message';
  }

  return 'unclear';
}

// Extract name from speech (improved)
function extractName(speech) {
  let name = speech.trim();
  // Remove common prefixes
  name = name.replace(/^(yeah|yes|my (first|last) name is|my name is|it's|i'm|this is|the name is)\s*/i, '');
  // Remove trailing punctuation
  name = name.replace(/[.,!?]$/g, '');
  // Clean up extra spaces
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

// Extract email from speech (improved)
function extractEmail(speech) {
  let email = speech.toLowerCase();
  // Remove common prefixes
  email = email.replace(/^(my email( address)? is|it's|the email is)\s*/i, '');
  // Remove all spaces
  email = email.replace(/\s+/g, '');
  // Convert speech to email format
  email = email.replace(/\bat\b/g, '@');
  email = email.replace(/\bdot\b/g, '.');
  return email;
}

// Build context-aware system prompt
function buildSystemPrompt(memory) {
  const baseContext = "You are a professional receptionist for Ahad and Co CPA Firm.";

  const statePrompts = {
    greeting: `${baseContext}\nIf this is the FIRST message (no history), say EXACTLY: "Thanks for calling Ahad and Co. How can I help you today?"\nOtherwise, say: "How can I help you today?"`,

    intent_clarification: `${baseContext}\nThe caller's intent is unclear. Ask politely:\n"I'd be happy to help. Are you looking to schedule an appointment, leave a message, or speak with someone?"`,

    office_hours_message: `${baseContext}\nSay: "No one is available right now. Our office hours are Monday through Friday, 10:00 AM to 6:00 PM. You can call back during business hours, or I can take a message for you. Would you like to leave a message?"`,

    office_hours_declined: `${baseContext}\nSay: "No problem. Please call us back during business hours, Monday through Friday, 10 AM to 6 PM. Have a great day! Goodbye."`,

    calendar_check: `${baseContext}\nSay: "Let me check our calendar for available times. One moment please."`,

    offer_slots: (() => {
      if (!memory.offered_slots || memory.offered_slots.length === 0) {
        return `${baseContext}\nSay: "I'm sorry, I don't see any availability right now. Let me take your message instead."`;
      }
      const slotsText = memory.offered_slots.map((s, i) => `${i + 1}. ${s.displayText}`).join(', ');
      return `${baseContext}\nPresent the available appointment times naturally.\nAvailable times: ${slotsText}\nSay something like: "I have a few times available: ${slotsText}. Which one works best for you?"`;
    })(),

    ask_preferred_time: `${baseContext}\nAsk: "What day and time would work better for you?"`,

    message_fallback_intro: `${baseContext}\nSay: "I'm having trouble finding a suitable time. Let me take your information and someone will call you back to schedule. May I have your first name?"`,

    appointment_first_name: `${baseContext}\nSay: "Perfect! Let me get some information to confirm your appointment. May I have your first name?"`,
    appointment_last_name: `${baseContext}\nSay: "And your last name?"`,
    appointment_email: `${baseContext}\nSay: "What's your email address?"`,
    appointment_phone: `${baseContext}\nSay: "And your phone number?"`,
    appointment_previous_client: `${baseContext}\nSay: "Have you worked with Ahad and Co before?"`,
    appointment_referral: `${baseContext}\nSay: "How did you hear about us?"`,
    appointment_call_reason: `${baseContext}\nSay: "What's the main reason for your call today?"`,
    appointment_complete: `${baseContext}\nSay: "Perfect! You're all set for ${memory.selected_slot}. You'll receive a confirmation email shortly. Thank you for calling Ahad and Co. Goodbye!"`,

    message_first_name: `${baseContext}\nSay: "I'd be happy to take a message. May I have your first name?"`,
    message_last_name: `${baseContext}\nSay: "And your last name?"`,
    message_phone: `${baseContext}\nSay: "What's the best phone number to reach you?"`,
    message_email: `${baseContext}\nSay: "And your email address?"`,
    message_content: `${baseContext}\nSay: "What message would you like to leave?"`,
    message_complete: `${baseContext}\nSay: "Thank you, ${memory.first_name}. Someone from our team will call you back shortly. Have a great day! Goodbye."`
  };

  return {
    role: "system",
    content: statePrompts[memory.flow_state] || `${baseContext}\nContinue the conversation professionally.`
  };
}

// Full memory like your Retell context
const conversationMemory = {};

app.post('/voice', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || '';
  const isFirstMessage = !userSpeech;

  console.log(`[${callSid}] Incoming call - Speech: "${userSpeech}"`);

  if (!conversationMemory[callSid]) {
    conversationMemory[callSid] = {
      // Intent & Flow Control
      intent: null,
      flow_state: 'greeting',

      // Calendar & Slot Tracking
      slot_offer_attempt: 0,
      offered_slots: [],
      user_preferred_time: null,
      selected_slot: null,
      selected_slot_iso: null,

      // User Information (shared)
      first_name: null,
      last_name: null,
      email: null,
      phone: null,

      // Appointment-specific
      previous_client: null,
      referral_source: null,
      call_reason: null,

      // Message-specific
      message_content: null,

      // Flags
      booking_completed: false,
      message_sent: false,
      conversation_ended: false,

      // History
      history: []
    };
  }
  const memory = conversationMemory[callSid];

  let agentText = "Sorry, I'm having a technical issue. Please try again later. Goodbye.";

  try {
    // Build conversation history with context-aware system prompt
    const messages = [buildSystemPrompt(memory)];

    // Add conversation history
    if (memory.history.length > 0) {
      memory.history.forEach(msg => messages.push(msg));
    }

    // Add current user input
    if (userSpeech) {
      messages.push({ role: "user", content: userSpeech });
    } else {
      messages.push({ role: "user", content: "FIRST_CALL_START" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.7,
      max_tokens: 150
    });

    agentText = completion.choices[0].message.content.trim();

    // Save to history
    if (userSpeech) {
      memory.history.push({ role: "user", content: userSpeech });
    }
    memory.history.push({ role: "assistant", content: agentText });

    // ===== MULTI-PATH STATE MACHINE =====
    if (userSpeech && userSpeech.trim()) {
      const lowerSpeech = userSpeech.toLowerCase();

      // ===== INTENT DETECTION (from greeting) =====
      if (memory.flow_state === 'greeting') {
        try {
          // Try OpenAI function calling for intent detection
          const intentDetection = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "You are an intent classifier for a CPA firm's phone system. Detect what the caller wants." },
              { role: "user", content: userSpeech }
            ],
            functions: [{
              name: "classify_intent",
              description: "Classify the caller's intent",
              parameters: {
                type: "object",
                properties: {
                  intent: {
                    type: "string",
                    enum: ["appointment", "message", "speak_to_person", "unclear"],
                    description: "The detected intent"
                  },
                  confidence: {
                    type: "number",
                    description: "Confidence score 0-1"
                  }
                },
                required: ["intent", "confidence"]
              }
            }],
            function_call: { name: "classify_intent" }
          });

          const intentResult = JSON.parse(
            intentDetection.choices[0].message.function_call.arguments
          );

          if (intentResult.confidence > 0.6) {
            memory.intent = intentResult.intent;
          } else {
            memory.intent = detectIntentByKeywords(userSpeech);
          }
        } catch (error) {
          console.error(`[${callSid}] Intent detection error:`, error.message);
          memory.intent = detectIntentByKeywords(userSpeech);
        }

        console.log(`[${callSid}] Intent detected: ${memory.intent}`);

        // Route based on intent
        if (memory.intent === 'speak_to_person') {
          memory.flow_state = 'office_hours_message';
        } else if (memory.intent === 'appointment') {
          memory.flow_state = 'calendar_check';
        } else if (memory.intent === 'message') {
          memory.flow_state = 'message_first_name';
        } else {
          memory.flow_state = 'intent_clarification';
        }
      }

      // ===== INTENT CLARIFICATION FLOW =====
      else if (memory.flow_state === 'intent_clarification') {
        // Re-detect intent from clarification response
        memory.intent = detectIntentByKeywords(userSpeech);
        console.log(`[${callSid}] Intent clarified: ${memory.intent}`);

        if (memory.intent === 'speak_to_person') {
          memory.flow_state = 'office_hours_message';
        } else if (memory.intent === 'appointment') {
          memory.flow_state = 'calendar_check';
        } else if (memory.intent === 'message') {
          memory.flow_state = 'message_first_name';
        } else {
          // Still unclear, default to appointment
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
        }
      }

      // ===== OFFICE HOURS FLOW =====
      else if (memory.flow_state === 'office_hours_message') {
        if (/yes|yeah|sure|ok/i.test(lowerSpeech)) {
          memory.flow_state = 'message_first_name';
        } else {
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
        }
      }

      // ===== CALENDAR CHECK FLOW =====
      else if (memory.flow_state === 'calendar_check') {
        const startDate = new Date();
        const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 2 weeks

        const slots = await getCalendarAvailability(startDate, endDate, memory.user_preferred_time);

        if (slots && slots.length > 0) {
          memory.offered_slots = slots;
          memory.flow_state = 'offer_slots';
          console.log(`[${callSid}] Offering ${slots.length} calendar slots`);
        } else {
          console.log(`[${callSid}] No calendar availability, switching to message flow`);
          agentText = "I'm sorry, I don't see any availability in the next two weeks. Let me take your message and someone will call you back.";
          memory.flow_state = 'message_first_name';
        }
      }

      // ===== SLOT OFFER & NEGOTIATION =====
      else if (memory.flow_state === 'offer_slots') {
        const acceptedSlot = detectSlotAcceptance(userSpeech, memory.offered_slots);

        if (acceptedSlot) {
          memory.selected_slot = acceptedSlot.displayText;
          memory.selected_slot_iso = acceptedSlot.iso;
          memory.flow_state = 'appointment_first_name';
          console.log(`[${callSid}] Slot accepted: ${memory.selected_slot}`);
        } else {
          memory.slot_offer_attempt++;
          console.log(`[${callSid}] Slot rejected (attempt ${memory.slot_offer_attempt}/3)`);

          if (memory.slot_offer_attempt >= 3) {
            memory.flow_state = 'message_fallback_intro';
          } else {
            memory.flow_state = 'ask_preferred_time';
          }
        }
      }

      else if (memory.flow_state === 'ask_preferred_time') {
        memory.user_preferred_time = userSpeech.trim();
        memory.flow_state = 'calendar_check';
        console.log(`[${callSid}] User preferred time: ${memory.user_preferred_time}`);
      }

      // ===== APPOINTMENT DATA COLLECTION =====
      else if (memory.flow_state === 'appointment_first_name') {
        memory.first_name = extractName(userSpeech);
        memory.flow_state = 'appointment_last_name';
        console.log(`[${callSid}] Appointment first_name: ${memory.first_name}`);
      }

      else if (memory.flow_state === 'appointment_last_name') {
        memory.last_name = extractName(userSpeech);
        memory.flow_state = 'appointment_email';
        console.log(`[${callSid}] Appointment last_name: ${memory.last_name}`);
      }

      else if (memory.flow_state === 'appointment_email') {
        memory.email = extractEmail(userSpeech);
        memory.flow_state = 'appointment_phone';
        console.log(`[${callSid}] Appointment email: ${memory.email}`);
      }

      else if (memory.flow_state === 'appointment_phone') {
        memory.phone = userSpeech.replace(/\D/g, '');
        memory.flow_state = 'appointment_previous_client';
        console.log(`[${callSid}] Appointment phone: ${memory.phone}`);
      }

      else if (memory.flow_state === 'appointment_previous_client') {
        if (/yes|yeah/i.test(lowerSpeech)) {
          memory.previous_client = 'Yes';
          memory.flow_state = 'appointment_call_reason';
        } else {
          memory.previous_client = 'No';
          memory.flow_state = 'appointment_referral';
        }
        console.log(`[${callSid}] Previous client: ${memory.previous_client}`);
      }

      else if (memory.flow_state === 'appointment_referral') {
        memory.referral_source = userSpeech.trim();
        memory.flow_state = 'appointment_call_reason';
        console.log(`[${callSid}] Referral source: ${memory.referral_source}`);
      }

      else if (memory.flow_state === 'appointment_call_reason') {
        memory.call_reason = userSpeech.trim();
        memory.flow_state = 'appointment_complete';
        console.log(`[${callSid}] Call reason: ${memory.call_reason}`);
      }

      // ===== MESSAGE DATA COLLECTION =====
      else if (memory.flow_state === 'message_first_name' || memory.flow_state === 'message_fallback_intro') {
        memory.first_name = extractName(userSpeech);
        memory.flow_state = 'message_last_name';
        console.log(`[${callSid}] Message first_name: ${memory.first_name}`);
      }

      else if (memory.flow_state === 'message_last_name') {
        memory.last_name = extractName(userSpeech);
        memory.flow_state = 'message_phone';
        console.log(`[${callSid}] Message last_name: ${memory.last_name}`);
      }

      else if (memory.flow_state === 'message_phone') {
        memory.phone = userSpeech.replace(/\D/g, '');
        memory.flow_state = 'message_email';
        console.log(`[${callSid}] Message phone: ${memory.phone}`);
      }

      else if (memory.flow_state === 'message_email') {
        memory.email = extractEmail(userSpeech);
        memory.flow_state = 'message_content';
        console.log(`[${callSid}] Message email: ${memory.email}`);
      }

      else if (memory.flow_state === 'message_content') {
        memory.message_content = userSpeech.trim();
        memory.flow_state = 'message_complete';
        console.log(`[${callSid}] Message content: ${memory.message_content}`);
      }
    }

    // Regenerate response if flow state changed during state machine processing
    if (userSpeech && userSpeech.trim()) {
      const regenerateStates = ['calendar_check', 'offer_slots', 'office_hours_message',
                                'intent_clarification', 'message_first_name', 'appointment_first_name',
                                'ask_preferred_time', 'message_fallback_intro'];

      if (regenerateStates.includes(memory.flow_state)) {
        const regenerateMessages = [buildSystemPrompt(memory)];
        regenerateMessages.push({ role: "user", content: "Continue the conversation based on the current state." });

        const regeneratedCompletion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: regenerateMessages,
          temperature: 0.7,
          max_tokens: 150
        });

        agentText = regeneratedCompletion.choices[0].message.content.trim();
        memory.history[memory.history.length - 1].content = agentText; // Update last assistant message
      }
    }

    console.log(`[${callSid}] Agent: "${agentText}"`);
    console.log(`[${callSid}] Flow State: ${memory.flow_state}`);
    console.log(`[${callSid}] Memory:`, JSON.stringify(memory, null, 2));

  } catch (error) {
    console.error(`[${callSid}] Error in AI processing:`, error);
    agentText = "Sorry, there was a technical issue. Please try again later. Goodbye.";
  }

  // ===== APPOINTMENT WEBHOOK =====
  if (memory.flow_state === 'appointment_complete' && !memory.booking_completed) {
    memory.booking_completed = true;
    console.log(`[${callSid}] Creating Cal.com booking and sending appointment to n8n...`);

    try {
      // Create Cal.com booking first
      let calComBookingId = null;
      if (memory.selected_slot_iso && calComApiKey && calComEventTypeId) {
        const booking = await createCalComBooking(memory.selected_slot_iso, {
          first_name: memory.first_name,
          last_name: memory.last_name,
          email: memory.email,
          phone: memory.phone,
          call_reason: memory.call_reason
        });
        calComBookingId = booking?.id || null;
      }

      // Send appointment booking to n8n
      await axios.post(n8nWebhook, {
        type: "appointment_booking",
        first_name: memory.first_name,
        last_name: memory.last_name,
        phone: memory.phone || req.body.From,
        email_address: memory.email,
        selected_slot: memory.selected_slot,
        selected_slot_iso: memory.selected_slot_iso,
        call_reason: memory.call_reason || "Tax consultation",
        previous_client: memory.previous_client || "No",
        referral_source: memory.referral_source || "Not applicable",
        booking_status: "confirmed",
        calcom_booking_id: calComBookingId,
        slot_offer_attempts: memory.slot_offer_attempt,
        timestamp: new Date().toISOString(),
        call_sid: callSid,
        intent: memory.intent,
        summary: `Appointment booked for ${memory.first_name} ${memory.last_name} on ${memory.selected_slot}`
      }, {
        timeout: 5000
      });

      console.log(`[${callSid}] Appointment booking sent to n8n successfully`);
    } catch (webhookError) {
      console.error(`[${callSid}] Error sending appointment to n8n:`, webhookError.message);
      // Continue anyway - don't fail the call
    }
  }

  // ===== MESSAGE WEBHOOK =====
  if (memory.flow_state === 'message_complete' && !memory.message_sent) {
    memory.message_sent = true;
    console.log(`[${callSid}] Sending message to n8n...`);

    try {
      // Build transcript summary from conversation history
      const transcriptSummary = memory.history
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n');

      await axios.post(n8nWebhook, {
        type: "message",
        first_name: memory.first_name,
        last_name: memory.last_name,
        phone: memory.phone || req.body.From,
        email_address: memory.email,
        call_reason: memory.message_content,
        summary: "Callback request / Message left",
        transcript_summary: transcriptSummary,
        timestamp: new Date().toISOString(),
        previous_client: memory.previous_client || "Unknown",
        intent: memory.intent,
        call_sid: callSid,
        callback_requested: true
      }, {
        timeout: 5000
      });

      console.log(`[${callSid}] Message sent to n8n successfully`);
    } catch (webhookError) {
      console.error(`[${callSid}] Error sending message to n8n:`, webhookError.message);
      // Continue anyway - don't fail the call
    }
  }

  // Check if conversation should end
  const shouldEnd =
    memory.flow_state === 'appointment_complete' ||
    memory.flow_state === 'message_complete' ||
    memory.flow_state === 'office_hours_declined' ||
    memory.conversation_ended ||
    agentText.toLowerCase().includes("goodbye");

  if (shouldEnd) {
    memory.conversation_ended = true;
    console.log(`[${callSid}] Conversation ended`);

    // Say goodbye and hangup
    twiml.say({
      voice: "Polly.Joanna-Neural",
      language: "en-US"
    }, agentText);
    twiml.hangup();

  } else {
    // Continue conversation - gather user input
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'phone_call'
    });

    // Generate and play audio inside gather
    try {
      // Try ElevenLabs TTS if configured
      if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
        const audioStream = await elevenlabs.generate({
          voice: process.env.ELEVENLABS_VOICE_ID,
          text: agentText,
          model_id: "eleven_multilingual_v2",
        });

        // Convert stream to buffer
        const chunks = [];
        for await (const chunk of audioStream) {
          chunks.push(Buffer.from(chunk));
        }
        const audioBuffer = Buffer.concat(chunks);

        // Upload to tmpfiles.org for public MP3 URL
        const formData = new FormData();
        formData.append('file', audioBuffer, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
        const uploadResponse = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
          headers: formData.getHeaders(),
          timeout: 10000
        });

        const audioUrl = uploadResponse.data?.data?.url?.replace('tmpfiles.org/', 'tmpfiles.org/dl/') || uploadResponse.data?.files?.file?.url?.full;

        if (audioUrl) {
          gather.play(audioUrl);
          console.log(`[${callSid}] Playing ElevenLabs audio`);
        } else {
          // Fallback to Twilio
          gather.say({
            voice: "Polly.Joanna-Neural",
            language: "en-US"
          }, agentText);
          console.log(`[${callSid}] ElevenLabs URL failed, using Twilio TTS`);
        }
      } else {
        // Use Twilio TTS
        gather.say({
          voice: "Polly.Joanna-Neural",
          language: "en-US"
        }, agentText);
        console.log(`[${callSid}] Using Twilio TTS`);
      }
    } catch (audioError) {
      console.error(`[${callSid}] Audio generation error:`, audioError.message);
      // Fallback to basic Twilio TTS
      gather.say({
        voice: "Polly.Joanna-Neural",
        language: "en-US"
      }, agentText);
    }

    // If no response after timeout, redirect to continue
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
