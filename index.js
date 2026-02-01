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

// Import prompts from external file
const { buildAllPrompts } = require('./prompts');

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
      end: new Date(new Date(slot.time).getTime() + 15 * 60 * 1000), // 15-minute slots
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
        lengthInMinutes: 15,  // 15-minute consultation
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

  const lower = speech.toLowerCase().trim();

  // Check for specific slot selection
  if (/(first|1|one)/i.test(lower) && offeredSlots[0]) return offeredSlots[0];
  if (/(second|2|two)/i.test(lower) && offeredSlots[1]) return offeredSlots[1];
  if (/(third|3|three)/i.test(lower) && offeredSlots[2]) return offeredSlots[2];
  if (/(fourth|4|four)/i.test(lower) && offeredSlots[3]) return offeredSlots[3];
  if (/(fifth|5|five)/i.test(lower) && offeredSlots[4]) return offeredSlots[4];

  // Generic acceptance patterns (more flexible - can appear anywhere in response)
  // Includes patterns like "Okay. Yes, it can." or "Yes that works" or "Sure"
  if (/(^|\s)(yes|yeah|sure|ok|okay|that works|sounds good|perfect|works for me|either|both|any)($|[\s.,!])/i.test(lower)) {
    return offeredSlots[0];
  }

  // Check for explicit rejection to avoid false positives
  if (/(no|nope|not|don't|none|neither)/i.test(lower)) {
    return null;
  }

  return null;
}

// Intent detection using keywords (fallback)
function detectIntentByKeywords(speech) {
  const lower = speech.toLowerCase();

  // INQUIRY patterns (new) - asking questions, not booking
  if (/(inquir|question|information|tell me about|what do you|ask about|tax services|speak to|talk to|someone|person|representative|human|give me a name|looking for)/i.test(lower)) {
    return 'inquiry';  // NEW: Route to office hours message ONLY
  }

  // OFFICE HOURS question (new) - asking about business hours
  if (/(office hours|when.*open|what time|hours|open|times|available times)/i.test(lower)) {
    return 'office_hours_question';  // NEW: Explain hours, then offer message OR booking
  }

  // APPOINTMENT patterns - clear booking intent
  if (/(appointment|book|schedule|consultation|make.*appointment|set up|meeting|slot)/i.test(lower)) {
    return 'appointment';
  }

  // CALL BACK patterns - user says they'll call back later (end call immediately)
  if (/(i'll call back|call you back|call back later|i will call back|calling back)/i.test(lower)) {
    return 'callback';  // End call with "No problem. Goodbye."
  }

  // MESSAGE patterns
  if (/(message|leave.*message|voice.*mail)/i.test(lower)) {
    return 'message';
  }

  return 'unclear';
}

// Extract name from speech (improved - more lenient)
function extractName(speech) {
  let name = speech.trim();

  // Remove common conversation prefixes (including comma-separated ones)
  name = name.replace(/^(sure,?|okay,?|yes,?|yeah,?|um,?|uh,?)\s*/i, '');

  // Remove "my name is" patterns
  name = name.replace(/^(my (first|last) name is|my name is|it's|i'm|this is|the name is)\s*/i, '');

  // Remove trailing punctuation
  name = name.replace(/[.,!?]$/g, '');

  // Clean up extra spaces
  name = name.replace(/\s+/g, ' ').trim();

  // Only reject if it's clearly invalid (very long or has question mark)
  if (name.split(' ').length > 5 || /\?/.test(name)) {
    console.log(`Invalid name detected: "${name}" - too long or contains question mark`);
    return '';
  }

  // If name is too short (less than 2 characters), reject
  if (name.length < 2) {
    console.log(`Invalid name detected: "${name}" - too short`);
    return '';
  }

  return name;
}

// Extract email from speech (improved)
function extractEmail(speech) {
  let email = speech.toLowerCase().trim();

  // Remove conversation prefixes
  email = email.replace(/^(sure,?|okay,?|yes,?|yeah,?|um,?|uh,?)\s*/i, '');

  // Remove common email prefixes
  email = email.replace(/^(my email( address)? is|it's|the email is)\s*/i, '');

  // Remove all spaces
  email = email.replace(/\s+/g, '');

  // Convert speech to email format
  email = email.replace(/\bat\b/g, '@');
  email = email.replace(/\bdot\b/g, '.');

  // Remove any remaining periods from sentences
  email = email.replace(/\.+$/g, '');

  // Validate: must contain @ and at least one dot after @
  if (!/@/.test(email) || !email.match(/@.+\./)) {
    console.log(`Invalid email detected: "${email}" - missing @ or domain`);
    return '';
  }

  return email;
}

// Build context-aware system prompt (now uses external prompts file)
function buildSystemPrompt(memory) {
  const statePrompts = buildAllPrompts(memory);
  const baseContext = "You are a professional receptionist for Ahad and Co CPA Firm. " +
    "PRONUNCIATION: Say 'Ahad' as 'AY-HAD'. " +
    "Be clear, professional, natural pace. " +
    "ABSOLUTELY FORBIDDEN: NEVER say 'malicious', 'suspicious', 'security', 'fraud', 'spam', 'detected'. Always help every caller.";

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
  const callerPhone = req.body.From || 'unknown';

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

      // Email spelling confirmation (NEW)
      email_spelled: null,              // Email during spelling confirmation
      email_confirmation_stage: null,   // Track which stage of confirmation

      // Retry counters for validation
      first_name_retry: 0,
      last_name_retry: 0,
      email_retry: 0,
      phone_retry: 0,

      // Flags
      greeting_done: false,
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

    // Skip AI generation if awaiting user intent and no speech (prevent greeting repetition)
    if (memory.flow_state === 'awaiting_intent' && !userSpeech) {
      agentText = '';  // Stay silent, just wait for user
      console.log(`[${callSid}] Awaiting intent, no speech - staying silent`);
    } else {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
        temperature: 0.7,
        max_tokens: 150
      });

      agentText = completion.choices[0].message.content.trim();

      // CRITICAL: Block any response containing forbidden words/phrases
      const forbiddenWords = /malicious|suspicious|security|fraud|spam|scam|block|detected|refuse|cannot help|can only assist with booking/i;
      if (forbiddenWords.test(agentText)) {
        console.log(`[${callSid}] BLOCKED forbidden response: "${agentText}"`);
        // Replace with appropriate response based on flow state
        if (memory.flow_state === 'greeting' || memory.flow_state === 'awaiting_intent') {
          agentText = "Thanks for calling Ahad and Co CPA Firm. How can I help you today?";
        } else if (memory.flow_state === 'inquiry_intent' || memory.flow_state === 'office_hours_message' || memory.flow_state === 'office_hours_question') {
          agentText = "No one is available now. Our office hours are Tuesday-Thursday, 11:00 AM to 5:00 PM. Please call back if you want to talk to someone, or you can leave a message. Do you want to leave a message?";
        } else {
          agentText = "How can I help you today?";
        }
      }
    }

    // Save to history
    if (userSpeech) {
      memory.history.push({ role: "user", content: userSpeech });
    }
    memory.history.push({ role: "assistant", content: agentText });

    // Mark greeting as done after first response (prevents repetition)
    if (memory.flow_state === 'greeting' && !memory.greeting_done) {
      memory.greeting_done = true;
      memory.flow_state = 'awaiting_intent';  // Change state to wait for user response
      console.log(`[${callSid}] Greeting done, now awaiting user intent`);
    }

    // ===== CALENDAR CHECK (runs even without speech - after "Let me check..." was said) =====
    // If we're in calendar_check state and have history (meaning "Let me check..." was already said),
    // actually check the calendar now
    if (memory.flow_state === 'calendar_check' && memory.history.length > 0) {
      console.log(`[${callSid}] Checking calendar availability...`);
      const startDate = new Date();
      const endDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 2 weeks

      const slots = await getCalendarAvailability(startDate, endDate, memory.user_preferred_time);

      if (slots && slots.length > 0) {
        memory.offered_slots = slots;
        memory.flow_state = 'offer_slots';
        console.log(`[${callSid}] Found ${slots.length} calendar slots`);
      } else {
        console.log(`[${callSid}] No calendar availability, asking if user wants to leave message`);
        memory.flow_state = 'message_fallback_intro';
      }
    }

    // ===== MULTI-PATH STATE MACHINE =====
    if (userSpeech && userSpeech.trim()) {
      const lowerSpeech = userSpeech.toLowerCase();

      // ===== INTENT DETECTION (from greeting or awaiting_intent) =====
      if (memory.flow_state === 'greeting' || memory.flow_state === 'awaiting_intent') {
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
        if (memory.intent === 'inquiry' || memory.intent === 'speak_to_person') {
          // NEW: Inquiry or speak-to-person → Office hours message ONLY (no booking push)
          memory.flow_state = 'inquiry_intent';  // Use new state
        }
        else if (memory.intent === 'office_hours_question') {
          // NEW: Office hours question → Explain hours, offer message OR booking
          memory.flow_state = 'office_hours_question';
        }
        else if (memory.intent === 'appointment') {
          // Set state to calendar_check - agent will say "Let me check our availability..."
          // Actual calendar check happens on next turn in calendar_check handler
          memory.flow_state = 'calendar_check';
          console.log(`[${callSid}] Appointment intent - will check calendar on next turn`);
        }
        else if (memory.intent === 'message') {
          memory.flow_state = 'message_first_name';
        }
        else if (memory.intent === 'callback') {
          // User says they'll call back - end call immediately
          memory.flow_state = 'callback_end';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User will call back - ending call`);
        }
        else {
          memory.flow_state = 'intent_clarification';
        }
      }

      // ===== INTENT CLARIFICATION FLOW =====
      else if (memory.flow_state === 'intent_clarification') {
        // Re-detect intent from clarification response
        memory.intent = detectIntentByKeywords(userSpeech);
        console.log(`[${callSid}] Intent clarified: ${memory.intent}`);

        if (memory.intent === 'inquiry' || memory.intent === 'speak_to_person') {
          memory.flow_state = 'inquiry_intent';
        }
        else if (memory.intent === 'office_hours_question') {
          memory.flow_state = 'office_hours_question';
        }
        else if (memory.intent === 'appointment') {
          // Set state to calendar_check - agent will say "Let me check our availability..."
          memory.flow_state = 'calendar_check';
          console.log(`[${callSid}] Appointment intent from clarification - will check calendar on next turn`);
        } else if (memory.intent === 'message') {
          memory.flow_state = 'message_first_name';
        } else if (memory.intent === 'callback') {
          // User says they'll call back - end call immediately
          memory.flow_state = 'callback_end';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User will call back - ending call`);
        } else {
          // Still unclear, default to appointment
          memory.intent = 'appointment';
          memory.flow_state = 'calendar_check';
          console.log(`[${callSid}] Unclear intent, defaulting to appointment - will check calendar on next turn`);
        }
      }

      // ===== OFFICE HOURS FLOW =====
      // STRICT: NEVER route to booking/calendar from this flow - ONLY message or decline
      else if (memory.flow_state === 'office_hours_message') {
        // Check if user wants to leave a message
        if (/yes|yeah|sure|ok|okay|alright|message|please/i.test(lowerSpeech)) {
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] User agreed to leave message`);
        }
        // Check if user is declining or wants to call back
        else if (/no|nope|not|call back|later|goodbye|bye|hang up/i.test(lowerSpeech)) {
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User declined message - ending call`);
        }
        // If user repeats "speak to someone", re-explain (stay in same state)
        else if (/(speak|talk) (to|with)|someone|person/i.test(lowerSpeech)) {
          memory.flow_state = 'office_hours_message';
          console.log(`[${callSid}] User still wants to speak to someone - re-explaining`);
        }
        // Default: assume they want to leave a message (NEVER route to booking)
        else {
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response, defaulting to message flow`);
        }
      }

      // ===== NEW: INQUIRY INTENT HANDLER =====
      // STRICT: NEVER route to booking/calendar from this flow - ONLY message or decline
      else if (memory.flow_state === 'inquiry_intent') {
        if (/yes|yeah|sure|ok|okay|alright|message|please/i.test(lowerSpeech)) {
          // User wants to leave a message
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] User agreed to leave message`);
        } else if (/no|nope|not|call back|later|goodbye|bye|hang up/i.test(lowerSpeech)) {
          // User declines - say "Thanks for calling. Goodbye."
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User declined message - ending call`);
        } else {
          // Default: assume they want to leave a message (NEVER route to booking)
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response in inquiry, defaulting to message flow`);
        }
      }

      // ===== NEW: OFFICE HOURS QUESTION HANDLER =====
      // STRICT: NEVER route to booking/calendar from this flow - ONLY message or decline
      else if (memory.flow_state === 'office_hours_question') {
        if (/yes|yeah|sure|ok|message|please|callback|call back/i.test(lowerSpeech)) {
          // User wants to leave a message
          memory.flow_state = 'message_first_name';
        } else if (/no|nope|not|later|goodbye|bye/i.test(lowerSpeech)) {
          // User declines
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
        } else {
          // Unclear - default to message flow (NEVER route to booking)
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response in office_hours_question, defaulting to message flow`);
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
          console.log(`[${callSid}] No calendar availability, asking if user wants to leave message`);
          memory.flow_state = 'message_fallback_intro';
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
          // Determine if user explicitly rejected the offered slots
          const rejectionPattern = /(no|nope|not|don't|none|neither|doesn't work|that won't work|no thanks)/i;
          const timePreferencePattern = /(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|morning|afternoon|evening|next week|next month|at \d{1,2}|:\d{2})/i;

          // If the caller proactively gave a preferred time, capture it and re-check availability
          if (timePreferencePattern.test(userSpeech.toLowerCase())) {
            memory.user_preferred_time = userSpeech.trim();
            memory.flow_state = 'calendar_check';
            console.log(`[${callSid}] Caller provided preferred time: ${memory.user_preferred_time} - re-checking availability`);
          }
          // If explicit rejection, ask for preferred time immediately
          else if (rejectionPattern.test(userSpeech.toLowerCase())) {
            memory.slot_offer_attempt++;
            console.log(`[${callSid}] Slot rejected (attempt ${memory.slot_offer_attempt}/4)`);

            if (memory.slot_offer_attempt >= 4) {
              // After 4 explicit rejections, switch to message flow
              memory.flow_state = 'message_fallback_intro';
              console.log(`[${callSid}] Max slot attempts reached, switching to message flow`);
            } else {
              // IMMEDIATELY ask for preferred time after ANY rejection
              memory.flow_state = 'ask_preferred_time';
              console.log(`[${callSid}] Asking caller for preferred time`);
            }
          }
          // If the response was neither an explicit rejection nor a time preference, assume unclear and re-offer without incrementing attempts
          else {
            console.log(`[${callSid}] Unclear response during slot offer; re-offering without counting as rejection`);
            memory.flow_state = 'offer_slots';
          }
        }
      }

      // Handle caller-provided preferred time after slot rejections
      else if (memory.flow_state === 'ask_preferred_time') {
        // Capture caller's preferred time phrase and re-run availability search
        memory.user_preferred_time = userSpeech.trim();
        memory.flow_state = 'calendar_check';
        console.log(`[${callSid}] Caller preferred time received: ${memory.user_preferred_time}`);
      }

      // ===== APPOINTMENT DATA COLLECTION =====
      else if (memory.flow_state === 'appointment_first_name') {
        // Accept first name on first attempt (do not repeat question multiple times)
        const extracted = extractName(userSpeech);
        memory.first_name = (extracted && extracted.length > 0) ? extracted : userSpeech.trim();
        memory.flow_state = 'appointment_last_name';
        memory.first_name_retry = 0; // Reset counter
        console.log(`[${callSid}] Appointment first_name recorded: ${memory.first_name}`);
      }

      else if (memory.flow_state === 'appointment_last_name') {
        const extracted = extractName(userSpeech);
        if (extracted && extracted.length > 0) {
          memory.last_name = extracted;
          memory.flow_state = 'appointment_phone';  // FIXED: phone before email
          memory.last_name_retry = 0;
          console.log(`[${callSid}] Appointment last_name: ${memory.last_name}`);
        } else {
          memory.last_name_retry++;
          console.log(`[${callSid}] Invalid last name, retry ${memory.last_name_retry}/2`);

          if (memory.last_name_retry >= 2) {
            memory.last_name = userSpeech.trim();
            memory.flow_state = 'appointment_phone';  // FIXED: phone before email
            console.log(`[${callSid}] Accepting last name after retries: ${memory.last_name}`);
          }
        }
      }

      else if (memory.flow_state === 'appointment_email') {
        // Capture email from user
        const extracted = extractEmail(userSpeech);
        if (extracted && extracted.length > 0) {
          memory.email_spelled = extracted;
          memory.flow_state = 'appointment_email_confirm';  // Go to confirmation
          memory.email_retry = 0;
          console.log(`[${callSid}] Appointment email captured: ${memory.email_spelled}`);
        } else {
          memory.email_retry++;
          console.log(`[${callSid}] Invalid email, retry ${memory.email_retry}/2`);

          if (memory.email_retry >= 2) {
            // Accept whatever was said after 2 retries
            memory.email_spelled = userSpeech.trim();
            memory.flow_state = 'appointment_email_confirm';
            console.log(`[${callSid}] Accepting email after retries: ${memory.email_spelled}`);
          }
        }
      }

      // SIMPLIFIED: Email confirmation - agent reads back email, waits for yes/no
      else if (memory.flow_state === 'appointment_email_confirm') {
        if (/yes|yeah|correct|right|yep|that's right|that is correct/i.test(lowerSpeech)) {
          // Email confirmed - proceed to next question
          memory.email = memory.email_spelled;
          memory.flow_state = 'appointment_previous_client';  // Question 5
          console.log(`[${callSid}] Email confirmed: ${memory.email}`);
        } else if (/no|wrong|incorrect|not right/i.test(lowerSpeech)) {
          // Re-collect email
          memory.email_spelled = null;
          memory.email_retry = 0;
          memory.flow_state = 'appointment_email';
          console.log(`[${callSid}] Email incorrect, restarting collection`);
        } else {
          // Check if user provided a correction directly
          const corrected = extractEmail(userSpeech);
          if (corrected) {
            memory.email_spelled = corrected;
            // Stay in confirm state to read back the corrected email
            console.log(`[${callSid}] Email corrected to: ${corrected}`);
          } else {
            // Unclear response - assume confirmed to avoid loop
            memory.email = memory.email_spelled;
            memory.flow_state = 'appointment_previous_client';
            console.log(`[${callSid}] Unclear response, assuming email confirmed: ${memory.email}`);
          }
        }
      }

      else if (memory.flow_state === 'appointment_phone') {
        const extracted = userSpeech.replace(/\D/g, '');
        if (extracted && extracted.length >= 10) {
          memory.phone = extracted;
          memory.flow_state = 'appointment_email';  // FIXED: now goes to email (question 4)
          memory.phone_retry = 0;
          console.log(`[${callSid}] Appointment phone: ${memory.phone}`);
        } else {
          memory.phone_retry++;
          console.log(`[${callSid}] Invalid phone, retry ${memory.phone_retry}/2`);

          if (memory.phone_retry >= 2) {
            memory.phone = extracted || userSpeech.replace(/\D/g, '');
            memory.flow_state = 'appointment_email';  // FIXED: now goes to email
            console.log(`[${callSid}] Accepting phone after retries: ${memory.phone}`);
          }
        }
      }

      else if (memory.flow_state === 'appointment_previous_client') {
        if (/yes|yeah|returning|client|previous/i.test(lowerSpeech)) {
          memory.previous_client = 'Yes';
          memory.flow_state = 'appointment_welcome_back';
        } else {
          memory.previous_client = 'No';
          memory.flow_state = 'appointment_referral';
        }
        console.log(`[${callSid}] Previous client: ${memory.previous_client}`);
      }

      else if (memory.flow_state === 'appointment_welcome_back') {
        // Prompt already asked "What is the reason for your call?" so capture it here
        memory.call_reason = userSpeech.trim();
        memory.flow_state = 'appointment_confirm';
        console.log(`[${callSid}] Returning client - call reason: ${memory.call_reason} (skipped referral)`);
      }

      else if (memory.flow_state === 'appointment_referral') {
        memory.referral_source = userSpeech.trim();
        memory.flow_state = 'appointment_call_reason';
        console.log(`[${callSid}] Referral source: ${memory.referral_source}`);
      }

      else if (memory.flow_state === 'appointment_call_reason') {
        memory.call_reason = userSpeech.trim();
        memory.flow_state = 'appointment_confirm';
        console.log(`[${callSid}] Call reason: ${memory.call_reason}`);
      }

      else if (memory.flow_state === 'appointment_confirm') {
        // Check if user confirms
        if (/yes|yeah|correct|right|yep/i.test(lowerSpeech)) {
          memory.flow_state = 'appointment_complete';
          console.log(`[${callSid}] Appointment confirmed, completing`);
        } else if (/no|nope|wrong|incorrect/i.test(lowerSpeech)) {
          // Re-collect information
          memory.flow_state = 'appointment_first_name';
          memory.first_name = null;
          memory.last_name = null;
          memory.phone = null;
          memory.email = null;
          console.log(`[${callSid}] Appointment details incorrect, restarting collection`);
        } else {
          // Assume yes if unclear
          memory.flow_state = 'appointment_complete';
          console.log(`[${callSid}] Unclear response, assuming appointment confirmed`);
        }
      }

      // ===== MESSAGE FALLBACK (No slots available) =====
      else if (memory.flow_state === 'message_fallback_intro') {
        // User was asked "Would you like to leave a message?"
        if (/yes|yeah|sure|ok|okay|alright|please|message/i.test(lowerSpeech)) {
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] User agreed to leave message after no slots`);
        } else if (/no|nope|not|call back|later|goodbye|bye/i.test(lowerSpeech)) {
          memory.flow_state = 'office_hours_declined';
          memory.conversation_ended = true;
          console.log(`[${callSid}] User declined message - ending call`);
        } else {
          // Default: assume they want to leave a message
          memory.flow_state = 'message_first_name';
          console.log(`[${callSid}] Unclear response, defaulting to message flow`);
        }
      }

      // ===== MESSAGE DATA COLLECTION =====
      else if (memory.flow_state === 'message_first_name') {
        // For message flow: collect first name, then ask for last name (per spec)
        const extracted = extractName(userSpeech);
        memory.first_name = (extracted && extracted.length > 0) ? extracted : userSpeech.trim();
        memory.first_name_retry = 0;
        memory.flow_state = 'message_last_name';
        console.log(`[${callSid}] Message first_name recorded: ${memory.first_name}`);
      }

      else if (memory.flow_state === 'message_last_name') {
        const extracted = extractName(userSpeech);
        if (extracted && extracted.length > 0) {
          memory.last_name = extracted;
          memory.flow_state = 'message_phone';
          memory.last_name_retry = 0;
          console.log(`[${callSid}] Message last_name: ${memory.last_name}`);
        } else {
          memory.last_name_retry++;
          console.log(`[${callSid}] Invalid last name, retry ${memory.last_name_retry}/2`);

          if (memory.last_name_retry >= 2) {
            memory.last_name = userSpeech.trim();
            memory.flow_state = 'message_phone';
            console.log(`[${callSid}] Accepting last name after retries: ${memory.last_name}`);
          }
        }
      }

      else if (memory.flow_state === 'message_phone') {
        const extracted = userSpeech.replace(/\D/g, '');
        if (extracted && extracted.length >= 10) {
          memory.phone = extracted;
          memory.flow_state = 'message_email';
          memory.phone_retry = 0;
          console.log(`[${callSid}] Message phone: ${memory.phone}`);
        } else {
          memory.phone_retry++;
          console.log(`[${callSid}] Invalid phone, retry ${memory.phone_retry}/2`);

          if (memory.phone_retry >= 2) {
            memory.phone = extracted || userSpeech.replace(/\D/g, '');
            memory.flow_state = 'message_email';
            console.log(`[${callSid}] Accepting phone after retries: ${memory.phone}`);
          }
        }
      }

      else if (memory.flow_state === 'message_email') {
        // Capture email from user
        const extracted = extractEmail(userSpeech);
        if (extracted && extracted.length > 0) {
          memory.email_spelled = extracted;
          memory.flow_state = 'message_email_confirm';  // Go to confirmation
          memory.email_retry = 0;
          console.log(`[${callSid}] Message email captured: ${memory.email_spelled}`);
        } else {
          memory.email_retry++;
          console.log(`[${callSid}] Invalid email, retry ${memory.email_retry}/2`);

          if (memory.email_retry >= 2) {
            // Accept whatever was said after 2 retries
            memory.email_spelled = userSpeech.trim();
            memory.flow_state = 'message_email_confirm';
            console.log(`[${callSid}] Accepting email after retries: ${memory.email_spelled}`);
          }
        }
      }

      // SIMPLIFIED: Message email confirmation - agent reads back, waits for yes/no
      else if (memory.flow_state === 'message_email_confirm') {
        if (/yes|yeah|correct|right|yep|that's right|that is correct/i.test(lowerSpeech)) {
          // Email confirmed - proceed to reason for call
          memory.email = memory.email_spelled;
          memory.flow_state = 'message_content';
          console.log(`[${callSid}] Message email confirmed: ${memory.email}`);
        } else if (/no|wrong|incorrect|not right/i.test(lowerSpeech)) {
          // Re-collect email
          memory.email_spelled = null;
          memory.email_retry = 0;
          memory.flow_state = 'message_email';
          console.log(`[${callSid}] Message email incorrect, restarting collection`);
        } else {
          // Check if user provided a correction directly
          const corrected = extractEmail(userSpeech);
          if (corrected) {
            memory.email_spelled = corrected;
            // Stay in confirm state to read back the corrected email
            console.log(`[${callSid}] Message email corrected to: ${corrected}`);
          } else {
            // Unclear response - assume confirmed to avoid loop
            memory.email = memory.email_spelled;
            memory.flow_state = 'message_content';
            console.log(`[${callSid}] Unclear response, assuming message email confirmed: ${memory.email}`);
          }
        }
      }

      else if (memory.flow_state === 'message_content') {
        const extracted = userSpeech.trim();
        if (extracted && extracted.length > 2) {
          memory.message_content = extracted;
          memory.flow_state = 'message_confirm';
          console.log(`[${callSid}] Message content: ${memory.message_content}`);
        } else {
          console.log(`[${callSid}] Message too short, staying in same state`);
        }
      }

      else if (memory.flow_state === 'message_confirm') {
        // Check if user confirms
        if (/yes|yeah|correct|right|yep/i.test(lowerSpeech)) {
          memory.flow_state = 'message_complete';
          console.log(`[${callSid}] Message confirmed, completing`);
        } else if (/no|nope|wrong|incorrect/i.test(lowerSpeech)) {
          // Re-collect information
          memory.flow_state = 'message_first_name';
          memory.first_name = null;
          memory.phone = null;
          memory.email = null;
          console.log(`[${callSid}] Message details incorrect, restarting collection`);
        } else {
          // Assume yes if unclear
          memory.flow_state = 'message_complete';
          console.log(`[${callSid}] Unclear response, assuming confirmed`);
        }
      }
    }

    // Regenerate response if flow state changed during state machine processing
    if (userSpeech && userSpeech.trim()) {
      const regenerateStates = ['calendar_check', 'offer_slots', 'office_hours_message', 'inquiry_intent',
                                'intent_clarification', 'message_fallback_intro', 'message_confirm',
                                'office_hours_question', 'ask_preferred_time', 'appointment_email_confirm',
                                'message_email_confirm', 'appointment_confirm'];

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
      // Create concise summary instead of full transcript (2-3 sentences max)
      const transcriptSummary = (() => {
        const userMessages = memory.history.filter(m => m.role === 'user').map(m => m.content);
        const reason = memory.message_content || userMessages[userMessages.length - 1] || 'No reason provided';

        return `User requested callback. Reason: ${reason}. Details: ${memory.first_name} ${memory.last_name}, ${memory.phone}, ${memory.email}.`;
      })();

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
        callback_requested: true,
        duplicate_detected: false
      }, {
        timeout: 5000
      });

      console.log(`[${callSid}] Message sent to n8n successfully`);
    } catch (webhookError) {
      console.error(`[${callSid}] Error sending message to n8n:`, webhookError.message);
      // Continue anyway - don't fail the call
    }
  }

  // Guard against empty responses (silence prevention)
  // BUT allow silence when awaiting_intent (user hasn't spoken yet after greeting)
  if (!agentText || agentText.trim().length === 0) {
    if (memory.flow_state === 'awaiting_intent') {
      // Stay silent - waiting for user to speak first
      console.log(`[${callSid}] Awaiting intent - staying silent`);
    } else if (memory.flow_state === 'calendar_check' || memory.flow_state === 'offer_slots') {
      agentText = "One moment please.";
      console.log(`[${callSid}] Empty response in critical state, injecting filler`);
    } else if (memory.flow_state === 'appointment_first_name' || memory.flow_state === 'appointment_last_name' ||
               memory.flow_state === 'message_first_name' || memory.flow_state === 'message_last_name') {
      agentText = "I didn't quite catch that. Could you please repeat?";
      console.log(`[${callSid}] Empty response during data collection, requesting repeat`);
    } else {
      agentText = "Sorry, I'm having a technical issue. Please try again. Goodbye.";
      console.log(`[${callSid}] Empty response, defaulting to error message`);
    }
  }

  // Check if conversation should end
  const shouldEnd =
    memory.flow_state === 'appointment_complete' ||
    memory.flow_state === 'message_complete' ||
    memory.flow_state === 'office_hours_declined' ||
    memory.flow_state === 'callback_end' ||
    memory.conversation_ended;

  // Generate and play audio (same logic for both continuing and ending)
  // Use Twilio TTS directly for more reliability (ElevenLabs can cause voice drops)
  if (shouldEnd) {
    twiml.say({
      voice: "Polly.Joanna-Neural",
      language: "en-US"
    }, agentText);
    console.log(`[${callSid}] Using Twilio TTS for goodbye`);
  } else if (agentText && agentText.trim().length > 0) {
    // Only speak if there's something to say
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'phone_call'
    });
    gather.say({
      voice: "Polly.Joanna-Neural",
      language: "en-US"
    }, agentText);
    console.log(`[${callSid}] Using Twilio TTS`);
  } else {
    // No text to say - just gather speech silently (awaiting_intent)
    twiml.gather({
      input: 'speech',
      action: '/voice',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'phone_call'
    });
    console.log(`[${callSid}] Silent gather - waiting for user speech`);
  }

  if (shouldEnd) {
    memory.conversation_ended = true;
    console.log(`[${callSid}] Conversation ended`);
    // Add 0.5 second pause before hangup (per spec: "Say 'Goodbye', wait 0.5 seconds, end_call")
    twiml.pause({ length: 0.5 });
    twiml.hangup();
  } else {
    // If no response after timeout, redirect to continue
    twiml.redirect('/voice');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
