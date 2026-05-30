const express = require('express');
const app = express();
app.use(express.json());

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN; // tú lo defines, cualquier texto
const OWNER_PSID       = process.env.OWNER_PSID;   // tu PSID de Facebook (te lo doy abajo)
const PORT             = process.env.PORT || 3000;

const conversations   = new Map();
const clientChecklist = new Map();
const firstMessage    = new Set();
const followupTimers  = new Map();
const pausedChats     = new Set();
const completedChats  = new Set();

const FOLLOWUP_DELAY  = 24 * 60 * 60 * 1000;

// ── SYSTEM PROMPT (mismo que WhatsApp) ──
const SYSTEM_PROMPT = `Eres Samuel, asesor de Liberty Media, una agencia digital peruana que crea páginas web profesionales.

ROL:
El cliente viene de un anuncio de Facebook — ya mostró interés. Tu trabajo es generar confianza rápido, recolectar los datos clave y agendar la llamada con el asesor. Este chat es por Messenger — el cliente NO tiene número de teléfono visible, por eso debes pedírselo explícitamente.

PERSONALIDAD:
- Cálido, cercano y profesional
- Natural, sin sonar a formulario ni a robot
- Máximo 2 oraciones por mensaje — breve y directo
- Texto plano sin asteriscos ni markdown
- Un solo emoji cuando sea natural
- MUY IMPORTANTE: Si el cliente ya dio información, úsala — NUNCA repitas una pregunta que ya respondió
- Usa el nombre del cliente cuando lo tengas

EL SERVICIO:
- Páginas web profesionales desde S/500
- Diseño personalizado, responsive, hosting primer año gratis, SSL, textos e imágenes incluidos
- Entrega en 3 a 7 días hábiles

TRABAJOS RECIENTES (mostrar en paso 3 siempre):
- https://vitain.pe/
- https://sanguchoncampesino.pe/
- https://lisoft.edu.pe/

PREGUNTAS FRECUENTES:
- Precio: "El servicio parte desde S/500. El asesor te dará la propuesta exacta."
- Hosting: "El hosting del primer año está incluido gratis, con SSL y servidor rápido."
- Tiempo: "Entre 3 y 7 días hábiles desde que aprobamos el proyecto."
- Dominio o mantenimiento: "El asesor te explicará cuando te llame."

FLUJO — en este orden exacto:

1. BIENVENIDA — mensaje corto, máximo 2 líneas:
"Hola, soy Samuel de Liberty Media. ¿A qué se dedica tu negocio?"
Nada más. Simple y directo. No expliques todo en el primer mensaje.

2. NOMBRE DEL NEGOCIO: Si el cliente solo dijo el rubro pero no el nombre, pregunta:
"¿Y cuál es el nombre de tu negocio?"
Si ya dio ambos, pasa directo al objetivo.

3. OBJETIVO: "¿Qué necesitas que haga tu web? Por ejemplo: mostrar tus propiedades, recibir consultas, o que los clientes te contacten."
Adapta el ejemplo al rubro del cliente.

4. MOSTRAR TRABAJOS + LOGO:
"Por cierto, aquí algunos trabajos recientes para que veas el nivel: https://vitain.pe/ — https://sanguchoncampesino.pe/ — https://lisoft.edu.pe/ ¿Tienes logo y colores de tu marca?"

5. DISPONIBILIDAD: "¿Qué días y horarios te vienen mejor para que te llamemos?"

6. NÚMERO DE TELÉFONO — CRÍTICO en Messenger:
"¿A qué número de WhatsApp o teléfono te llamamos?"
NUNCA preguntes "este mismo número" — en Messenger no hay número automático.
SIEMPRE pide el número explícitamente con dígitos.
Si el cliente dice "este número" o "el mismo", responde:
"Para poder llamarte necesito el número. ¿Cuál es tu WhatsApp o teléfono?"

7. NOMBRE: "¿Y cómo te llamas?"

8. CIERRE — solo cuando tengas negocio, objetivo, disponibilidad y número con dígitos reales:
"Perfecto [nombre], ya tengo todo. En las próximas horas nuestro equipo te contactará para coordinar los detalles de la web de [negocio]."

REGLAS CRÍTICAS:
- NUNCA repitas una pregunta que el cliente ya respondió — lee el historial
- NUNCA uses "este mismo número" — siempre pide el número con dígitos
- NUNCA cierres sin tener un número de teléfono real con dígitos
- Una pregunta por mensaje
- NUNCA menciones pagos ni adelantos
- Si manda sticker: ignóralo y continúa
- Nunca menciones inteligencia artificial`

// ── CHECKLIST ──
function getChecklist(psid) {
  if (!clientChecklist.has(psid)) {
    clientChecklist.set(psid, {
      negocio: false,        negocioValor: '',
      objetivo: false,       objetivoValor: '',
      logo: false,           logoValor: '',
      disponibilidad: false, disponibilidadValor: '',
      numero: false,         numeroValor: '',
      nombre: false,         nombreValor: '',
      urgencia: 'normal'
    });
  }
  return clientChecklist.get(psid);
}

function isReadyToClose(psid) {
  const c = getChecklist(psid);
  return c.negocio && c.objetivo && c.disponibilidad && c.numero;
}

// ── ACTUALIZAR CHECKLIST ──
function updateChecklist(psid, userMsg, botReply) {
  const c = getChecklist(psid);
  const u = userMsg.toLowerCase();
  const b = (botReply || '').toLowerCase();
  const val = userMsg.trim();

  // Capturar negocio cuando Samuel preguntó por él y el cliente respondió algo
  if (!c.negocio && (b.includes('dedica') || b.includes('nombre de tu negocio') ||
    b.includes('a qué se dedica') || b.includes('cuál es el nombre')) && val.length > 1)
    { c.negocio = true; c.negocioValor = val; }
  // También capturar si el cliente da su rubro directamente sin que Samuel lo pida
  if (!c.negocio && val.length > 2 && conversations.has(psid) &&
    conversations.get(psid).length <= 2)
    { c.negocio = true; c.negocioValor = val; }
  if (!c.objetivo && (b.includes('necesitas que haga') || b.includes('objetivo') || b.includes('mostrar')) && val.length > 2)
    { c.objetivo = true; c.objetivoValor = val; }
  if (!c.logo && (b.includes('logo') || b.includes('colores')) && val.length > 1)
    { c.logo = true; c.logoValor = val; }

  const dias = ['lunes','martes','miércoles','miercoles','jueves','viernes',
    'sábado','sabado','domingo','mañana','tarde','noche','cualquier',
    'disponible','semana','am','pm',':00',':30','hoy','mañana'];
  if (!c.disponibilidad && dias.some(d => u.includes(d)))
    { c.disponibilidad = true; c.disponibilidadValor = val; }
  // Si Samuel preguntó disponibilidad y el cliente respondió cualquier cosa
  if (!c.disponibilidad && (b.includes('horarios') || b.includes('días y horarios') ||
    b.includes('mejor momento') || b.includes('te viene mejor')) && val.length > 1)
    { c.disponibilidad = true; c.disponibilidadValor = val; }

  // Número — en Messenger SIEMPRE requiere dígitos reales
  const phoneMatch = userMsg.match(/\d{6,12}/);
  if (!c.numero && phoneMatch && phoneMatch[0].length >= 6) {
    c.numero = true; c.numeroValor = phoneMatch[0];
  }
  // Si el cliente dice "este número" o "el mismo" — NO marcar como capturado
  // Samuel debe pedir el número explícitamente con dígitos
  const sinDigitos = !phoneMatch && (
    u.includes('este número') || u.includes('este numero') ||
    u.includes('el mismo') || u.includes('este whatsapp') ||
    u.includes('mismo') || u === 'sí' || u === 'si' || u === 'ok'
  );
  if (sinDigitos) {
    // No marcar numero — dejar que Samuel pida los dígitos reales
    console.log('Número sin dígitos detectado — Samuel pedirá el número explícito');
  }

  if (!c.nombre && (b.includes('cómo te llamas') || b.includes('como te llamas')) && val.length > 1)
    { c.nombre = true; c.nombreValor = val; }

  if (u.includes('urgente') || u.includes('lo antes posible') || u.includes('para el lanzamiento'))
    { c.urgencia = 'urgente'; }
}

// ── LLAMAR A GPT-4o ──
async function callGPT(psid, userMessage) {
  if (!conversations.has(psid)) conversations.set(psid, []);
  const history = conversations.get(psid);

  history.push({ role: 'user', content: userMessage });
  const trimmedHistory = history.slice(-20);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...trimmedHistory
        ],
        max_tokens: 300,
        temperature: 0.7
      })
    });

    if (!response.ok) throw new Error(await response.text());

    const data = await response.json();
    const botReply = data.choices?.[0]?.message?.content;
    if (!botReply) throw new Error('Respuesta vacía');

    history.push({ role: 'assistant', content: botReply });
    updateChecklist(psid, userMessage, botReply);

    return botReply;

  } catch(err) {
    console.error('Error GPT-4o:', err.message);
    return null;
  }
}

// ── ENVIAR MENSAJE POR MESSENGER ──
async function sendMessage(psid, text) {
  try {
    const response = await fetch(
      'https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_ACCESS_TOKEN,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: psid },
          message: { text },
          messaging_type: 'RESPONSE'
        })
      }
    );
    if (!response.ok) {
      const err = await response.text();
      console.error('Error enviando mensaje:', err);
    }
  } catch(err) {
    console.error('Error Messenger API:', err.message);
  }
}

// ── NOTIFICAR AL DUEÑO ──
async function notifyOwner(psid, conv) {
  if (!OWNER_PSID) return;

  const now = new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' });
  const c = clientChecklist.get(psid) || {};
  const na = 'No especificado';
  const urgTag = c.urgencia === 'urgente' ? ' — URGENTE' : '';

  // Resumen IA
  const convText = conv.map(m => (m.role === 'user' ? 'CLIENTE' : 'SAMUEL') + ': ' + m.content).join('\n');
  let resumenIA = '';
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 120,
        temperature: 0.2,
        messages: [{ role: 'user',
          content: 'En máximo 2 líneas en español, resume qué necesita este cliente para su web:\n\n' + convText
        }]
      })
    });
    const d = await res.json();
    resumenIA = d.choices?.[0]?.message?.content?.trim() || '';
  } catch(e) {}

  const notification =
    'NUEVO LEAD (Messenger)' + urgTag + '\n\n' +
    'Nombre: '      + (c.nombreValor        || na) + '\n' +
    'Negocio: '     + (c.negocioValor        || na) + '\n' +
    'Objetivo: '    + (c.objetivoValor       || na) + '\n' +
    'Logo: '        + (c.logoValor           || na) + '\n\n' +
    (resumenIA ? resumenIA + '\n\n' : '') +
    'Llamar al: '   + (c.numeroValor         || 'Ver Messenger') + '\n' +
    'Disponible: '  + (c.disponibilidadValor || na) + '\n' +
    'Facebook: messenger.com/t/' + psid;

  await sendMessage(OWNER_PSID, notification);
  console.log('Lead enviado al dueño — ' + now);
}

// ── SEGUIMIENTO 24H ──
function scheduleFollowup(psid) {
  if (followupTimers.has(psid)) clearTimeout(followupTimers.get(psid));
  const timer = setTimeout(async () => {
    if (pausedChats.has(psid) || isReadyToClose(psid)) return;
    const conv = conversations.get(psid) || [];
    if (conv.length === 0) return;
    console.log('Seguimiento a ' + psid);
    await sendMessage(psid, 'Hola, soy Samuel de Liberty Media. Solo quería confirmar si sigues interesado en la web para tu negocio. Estamos disponibles esta semana.');
    followupTimers.delete(psid);
  }, FOLLOWUP_DELAY);
  followupTimers.set(psid, timer);
}

// ── PROCESAR MENSAJE ENTRANTE ──
async function processMessage(psid, userText) {
  if (pausedChats.has(psid)) return;

  // Si el cliente escribe después de completar el flujo
  if (completedChats.has(psid)) {
    if (!completedChats.has(psid + '_replied')) {
      completedChats.add(psid + '_replied');
      await new Promise(r => setTimeout(r, 3000));
      await sendMessage(psid, 'Con gusto. Pronto tendrás noticias nuestras.');
    }
    return;
  }

  console.log('Mensaje de ' + psid + ': ' + userText.substring(0, 80));

  // Simular que está escribiendo
  await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + PAGE_ACCESS_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      sender_action: 'typing_on'
    })
  }).catch(() => {});

  // Tiempo de espera natural
  const isFirst = !firstMessage.has(psid);
  if (isFirst) firstMessage.add(psid);
  const thinkTime = isFirst ? 3000 : Math.min(8000 + userText.length * 15, 12000);
  await new Promise(r => setTimeout(r, thinkTime));

  const reply = await callGPT(psid, userText);
  if (!reply) return;

  await sendMessage(psid, reply);
  console.log('Samuel: ' + reply.substring(0, 100));

  scheduleFollowup(psid);

  // Verificar cierre — basado en checklist, no en frases del modelo
  const c = getChecklist(psid);
  const rl = reply.toLowerCase();
  const checklistOk = c.negocio && c.objetivo && c.disponibilidad && c.numero;

  // Notificar cuando checklist completo Y Samuel está cerrando o ya cerró
  const samuelCerro =
    rl.includes('asesor') ||
    rl.includes('llamar') ||
    rl.includes('ya tengo') ||
    rl.includes('hablamos') ||
    rl.includes('coordinar') ||
    rl.includes('disponibilidad') ||
    rl.includes('perfecto') && rl.includes('todo');

  if (checklistOk && samuelCerro) {
    console.log('\n===== CIERRE DETECTADO =====');
    console.log('PSID: ' + psid);
    console.log('Negocio: ' + c.negocioValor);
    console.log('Disponibilidad: ' + c.disponibilidadValor);
    console.log('Numero: ' + c.numeroValor);
    console.log('============================\n');

    if (followupTimers.has(psid)) {
      clearTimeout(followupTimers.get(psid));
      followupTimers.delete(psid);
    }
    const conv = conversations.get(psid) || [];
    await notifyOwner(psid, conv);
    completedChats.add(psid);
    conversations.delete(psid);
    clientChecklist.delete(psid);
    firstMessage.delete(psid);
  } else if (checklistOk) {
    // Checklist completo pero Samuel aún no cerró — forzar notificación en el próximo mensaje
    console.log('Checklist completo, esperando cierre de Samuel...');
    console.log('neg=' + c.negocio + ' obj=' + c.objetivo + ' disp=' + c.disponibilidad + ' num=' + c.numero);
  }
}

// ── WEBHOOK VERIFICATION (Meta lo requiere) ──
app.get('/webhook', (req, res) => {
  const mode  = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verificado');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── RECIBIR MENSAJES ──
app.post('/webhook', (req, res) => {
  const body = req.body;
  res.sendStatus(200); // responder siempre 200 primero

  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender?.id;
      if (!psid) continue;

      // Ignorar mensajes del bot mismo
      if (event.sender?.id === event.recipient?.id) continue;

      if (event.message) {
        const text = event.message.text;
        const attachments = event.message.attachments;

        if (text) {
          processMessage(psid, text).catch(console.error);
        } else if (attachments) {
          // Imagen o archivo
          const attachment = attachments[0];
          if (attachment.type === 'image') {
            processMessage(psid, '(imagen enviada)').catch(console.error);
          }
        }
      }
    }
  }
});

// ── HEALTH CHECK ──
app.get('/', (req, res) => res.send('Liberty Media Messenger Bot activo'));

app.listen(PORT, () => {
  console.log('Servidor en puerto ' + PORT);
  console.log('Webhook: /webhook');
});
