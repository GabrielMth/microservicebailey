import makeWASocket, {
  AnyMessageContent,
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  isJidNewsletter,
} from 'baileys'
import NodeCache from '@cacheable/node-cache'
import P from 'pino'
import { Boom } from '@hapi/boom'
import * as QRCode from 'qrcode'
import fs from 'fs'

const logger = P({ level: 'error', timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))

const replyCache = new NodeCache({ stdTTL: 5000 })

const isIgnoredJid = (jid: string) =>
  jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@channel') || isJidNewsletter(jid)

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
  const { version } = await fetchLatestBaileysVersion()
  console.log(`Usando WA v${version.join('.')}`)

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
  })

  const sendMessageWTyping = async (jid: string, message: AnyMessageContent) => {
    await sock.presenceSubscribe(jid)
    await delay(500)
    await sock.sendPresenceUpdate('composing', jid)
    await delay(2000)
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, message)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))

    if (connection === 'close') {
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('Desconectado. Limpando dados...')
        fs.rmSync('baileys_auth_info', { recursive: true, force: true })
      }
      await delay(2000)
      return startSock()
    }

    if (connection === 'open') console.log('Conectado com sucesso!')
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async (upsert) => {
    if (upsert.type !== 'notify') return

    for (const msg of upsert.messages) {
      const sender = msg.key.remoteJid!
      if (msg.key.fromMe || isIgnoredJid(sender) || replyCache.has(sender)) continue

      await sock.readMessages([msg.key])
      const now = new Date()
      const hour = now.getHours()
      const pushName = msg.pushName || "Querido cliente"

      if (hour >= 8 && hour < 18) {
        const greeting = hour < 12 ? `☀ Bom dia, ${pushName}!` : `🌤 Boa tarde, ${pushName}!`
        const intro = `${greeting}

Agradecemos por entrar em contato com a Casa de Ração AuQueMia 🏡🐶😺❤.

Oferecemos **entrega grátis** para sua comodidade.
Nosso horário de atendimento é
*Segunda-Feira* | *Domingo* 
a partir das *08h00* às *18h00*.`

        const followUp = `Olá! Meu nome é Rita e estou à disposição.`

        await sendMessageWTyping(sender, { text: intro })
        await delay(1000)
        await sendMessageWTyping(sender, { text: followUp })
      } else {
        const closed = `Olá, ${pushName}!

Estamos fechados 😕
Nosso horário de atendimento é
*Segunda-Feira* | *Domingo* 
a partir das *08h00* às *18h00*.
Deixe sua mensagem e responderemos assim que possível.
Agradecemos a preferência ❣`

        await sendMessageWTyping(sender, { text: closed })
      }

      replyCache.set(sender, true)
      console.log(`Mensagem enviada para ${sender} às ${now.toLocaleString('pt-BR')}`)
    }
  })

  return sock
}

startSock().catch(err => console.error('Erro na conexão:', err))
