import makeWASocket, {
  AnyMessageContent,
  delay,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  isJidNewsletter
} from 'baileys'
import NodeCache from '@cacheable/node-cache'
import P from 'pino'
import { Boom } from '@hapi/boom'
import readline from 'readline'
import QRCode from 'qrcode'

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const msgRetryCounterCache = new NodeCache()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Imprime QR no terminal para escanear
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }))
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('Reconectando...')
        startSock()
      } else {
        console.log('Você foi desconectado (logout).')
      }
    } else if (connection === 'open') {
      console.log('Conectado com sucesso!')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // Função para enviar mensagem simulando "digitando"
  async function sendMessageWTyping(jid: string, message: AnyMessageContent) {
    await sock.presenceSubscribe(jid)
    await delay(500)
    await sock.sendPresenceUpdate('composing', jid)
    await delay(2000)
    await sock.sendPresenceUpdate('paused', jid)
    await sock.sendMessage(jid, message)
  }

  const lastReplyDateMap = new Map<string, string>()

  sock.ev.on('messages.upsert', async (upsert) => {
    if (upsert.type !== 'notify') return

    for (const msg of upsert.messages) {
      if (!msg.key.fromMe && !isJidNewsletter(msg.key.remoteJid!)) {
        const sender = msg.key.remoteJid!

        // Pega a data de hoje no formato YYYY-MM-DD
        const today = new Date().toISOString().slice(0, 10)

        const lastReplyDate = lastReplyDateMap.get(sender)

        if (lastReplyDate !== today) {
          // Marca mensagem como lida
          await sock.readMessages([msg.key])

          // Envia mensagem padrão
          const replyText = 'Olá! Você entrou em contato com a nossa loja.\nAcesse nosso cardápio digital em: https://minhaloja.com/cardapio'
          await sendMessageWTyping(sender, { text: replyText })

          // Atualiza a última data de resposta para hoje
          lastReplyDateMap.set(sender, today)

          console.log(`Mensagem respondida para ${sender}`)
        } else {
          console.log(`Já respondeu para ${sender} hoje, ignorando.`)
        }
      }
    }
  })

  return sock
}

startSock().catch(err => console.error('Erro na conexão:', err))
