require('dotenv').config();
const express = require("express")
const path = require("path")
const fs = require("fs").promises
const { GoogleGenerativeAI } = require("@google/generative-ai")
const uuid = require("uuid")
const cors = require("cors")
const bodyParser = require("body-parser")

// Firebase kurulum
const { initializeApp } = require("firebase/app")
const {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} = require("firebase/auth")

const app = express()
const PORT = process.env.PORT || 5000

// Firebase konfigürasyonu - Environment Variables ile
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
}

// Firebase'i başlat
const firebaseApp = initializeApp(firebaseConfig)
const auth = getAuth(firebaseApp)

// Google Generative AI konfigürasyonu - Environment Variable ile
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY)
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

// Sabitler
const CHAT_DATA_DIR = path.join(__dirname, "chat_data")
const CURRENT_CHAT_ID_FILE = path.join(CHAT_DATA_DIR, "current_chat_id.txt")
const SUMMARY_PROMPT = `Önceki konuşmalarımızın özetini yap ve ana konuları maddeler halinde özetle. 
Özet maksimum 3 cümle olmalı. Format:
<ÖZET>konuşma özeti</ÖZET>
<BEKLENEN>kullanıcının devam ettirebileceği konular veya açabileceği yeni konular</BEKLENEN>`

// Middleware'ler - Production için optimize edilmiş CORS
const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? [process.env.FRONTEND_URL, "https://*.onrender.com"]
      : ["http://localhost:5000", "http://127.0.0.1:5000"],
  credentials: true,
  optionsSuccessStatus: 200,
}

app.use(cors(corsOptions))
app.use(bodyParser.json({ limit: "10mb" }))
app.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }))
app.use(express.static(__dirname))

// Health check endpoint for Render
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
  })
})

// Chat_data dizini yoksa oluştur
async function ensureChatDataDir() {
  try {
    await fs.mkdir(CHAT_DATA_DIR, { recursive: true })
    console.log("Chat data directory ensured")
  } catch (err) {
    console.error("Chat data dizini oluşturulamadı:", err)
  }
}

// Yardımcı fonksiyonlar
async function getCurrentChatId() {
  try {
    const data = await fs.readFile(CURRENT_CHAT_ID_FILE, "utf8")
    return Number.parseInt(data.trim()) || 1
  } catch (err) {
    return 1
  }
}

async function setCurrentChatId(chatId) {
  try {
    await fs.writeFile(CURRENT_CHAT_ID_FILE, chatId.toString())
  } catch (err) {
    console.error("Chat ID kaydedilemedi:", err)
  }
}

async function loadChatHistory(chatId) {
  const filePath = path.join(CHAT_DATA_DIR, `chat_${chatId}.json`)
  try {
    const data = await fs.readFile(filePath, "utf8")
    return JSON.parse(data)
  } catch (err) {
    return []
  }
}

async function saveChatHistory(chatId, history) {
  const filePath = path.join(CHAT_DATA_DIR, `chat_${chatId}.json`)
  try {
    await fs.writeFile(filePath, JSON.stringify(history, null, 2))
  } catch (err) {
    console.error("Chat geçmişi kaydedilemedi:", err)
  }
}

async function loadSummaryData(chatId) {
  const filePath = path.join(CHAT_DATA_DIR, `chat_${chatId}_summary.json`)
  try {
    const data = await fs.readFile(filePath, "utf8")
    return JSON.parse(data)
  } catch (err) {
    return null
  }
}

async function saveSummaryData(chatId, summaryData) {
  const filePath = path.join(CHAT_DATA_DIR, `chat_${chatId}_summary.json`)
  try {
    await fs.writeFile(filePath, JSON.stringify(summaryData, null, 2))
  } catch (err) {
    console.error("Özet kaydedilemedi:", err)
  }
}

// Özet oluşturma fonksiyonu
async function generateAndSaveSummary(chatId, chatHistory) {
  if (!chatHistory || chatHistory.length === 0) {
    const summaryData = {
      summary: "Sohbet geçmişi boş.",
      expected: "Yeni bir sohbet başlatın.",
    }
    await saveSummaryData(chatId, summaryData)
    return summaryData
  }

  try {
    const recentHistory = chatHistory.slice(-15)
    const cleanHistory = recentHistory.map((msg) => ({
      role: msg.role,
      parts: msg.parts,
    }))

    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: `${SUMMARY_PROMPT}\n\nKonuşma Geçmişi:\n${JSON.stringify(cleanHistory)}` }],
        },
      ],
    })

    const response = await result.response
    const text = response.text()

    const summaryText = text.match(/<ÖZET>(.*?)<\/ÖZET>/s)?.[1]?.trim() || "Özet çıkarılamadı"
    const expectedText = text.match(/<BEKLENEN>(.*?)<\/BEKLENEN>/s)?.[1]?.trim() || "Beklenen konular belirlenemedi"

    const summaryData = {
      timestamp: new Date().toISOString(),
      summary: summaryText,
      expected: expectedText,
      full_response: text,
    }

    await saveSummaryData(chatId, summaryData)
    return summaryData
  } catch (err) {
    console.error("Özet oluşturulamadı:", err)
    return {
      summary: "Özet oluşturulamadı",
      expected: "Tekrar deneyin",
    }
  }
}

// Yanıt işleme fonksiyonları
function filterResponse(text) {
  const sensitiveQuestions = {
    "(senin adın ne|ismin ne|adın nedir)\\??": "Benim adım Asistan, Aslan tarafından geliştirildim.",
    "(seni kim yaptı|kim geliştirdi|yaratıcın kim)\\??": "Beni Aslan geliştirdi.",
    "(google|gemini|ai)\\s*(hakkında|ile ilgili)\\s*": "",
  }

  for (const [pattern, replacement] of Object.entries(sensitiveQuestions)) {
    text = text.replace(new RegExp(pattern, "gi"), replacement)
  }

  text = text.replace(/\b(Google|Gemini|AI)\b/gi, "Aslan")
  text = text.replace(/\b(Google's|Gemini's)\b/gi, "Aslan'ın")

  return text.trim()
}

function processAiResponseForHtml(aiResponseText) {
  const codeBlocks = []
  let processedText = aiResponseText

  const codeBlockPattern = /```(\w+)(?:\s+file="([^"]+)")?\n(.*?)```/gs
  const matches = [...aiResponseText.matchAll(codeBlockPattern)]

  matches.forEach((match, i) => {
    const fullMatch = match[0]
    const language = match[1]
    const filename = match[2] || `code_block_${i}.${language}`
    const content = match[3].trim()

    const blockId = `code_${uuid.v4().slice(0, 8)}`

    codeBlocks.push({
      id: blockId,
      language: language,
      filename: filename,
      content: content,
    })

    processedText = processedText.replace(fullMatch, `[CODE_BLOCK_${i}]`)
  })

  processedText = processedText.replace(/```/g, "")
  return { processedText: processedText.trim(), codeBlocks }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Error:", err)
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === "production" ? "Sunucu hatası" : err.message,
  })
})

// API Endpoint'leri
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

app.get("/home.html", (req, res) => {
  res.sendFile(path.join(__dirname, "home.html"))
})

app.get("/get_summary", async (req, res) => {
  try {
    const currentId = await getCurrentChatId()
    const summaryData = await loadSummaryData(currentId)

    if (summaryData) {
      res.json({ success: true, summary: summaryData.summary })
    } else {
      res.json({ success: false, summary: "Özet bulunamadı." })
    }
  } catch (err) {
    console.error("Özet getirme hatası:", err)
    res.status(500).json({ success: false, error: "Sunucu hatası" })
  }
})

app.get("/list_chats", async (req, res) => {
  try {
    const files = await fs.readdir(CHAT_DATA_DIR)
    const chats = []

    for (const file of files) {
      if (file.startsWith("chat_") && file.endsWith(".json") && !file.includes("_summary")) {
        try {
          const chatId = Number.parseInt(file.replace("chat_", "").replace(".json", ""))
          const summaryData = await loadSummaryData(chatId)
          const chatHistory = await loadChatHistory(chatId)

          let lastMessageTime = null
          if (chatHistory.length > 0) {
            lastMessageTime = chatHistory[chatHistory.length - 1].timestamp
          }

          chats.push({
            id: chatId,
            summary: summaryData?.summary || "Özet yok",
            last_message_time: lastMessageTime,
          })
        } catch (err) {
          console.error(`Chat ${file} işlenirken hata:`, err)
        }
      }
    }

    chats.sort((a, b) => b.id - a.id)
    res.json({ success: true, chats })
  } catch (err) {
    console.error("Chat listeleme hatası:", err)
    res.status(500).json({ success: false, error: "Sunucu hatası" })
  }
})

app.get("/load_chat/:chatId", async (req, res) => {
  try {
    const chatId = Number.parseInt(req.params.chatId)
    if (isNaN(chatId)) {
      return res.status(400).json({ success: false, error: "Geçersiz chat ID" })
    }

    await setCurrentChatId(chatId)

    const chatHistory = await loadChatHistory(chatId)
    const processedHistory = []

    for (const msg of chatHistory) {
      if (msg.role === "model") {
        const { processedText, codeBlocks } = processAiResponseForHtml(msg.parts[0])
        processedHistory.push({
          role: msg.role,
          content: processedText,
          processed_content: processedText,
          code_blocks: codeBlocks,
        })
      } else {
        processedHistory.push({
          role: msg.role,
          content: msg.parts[0],
        })
      }
    }

    res.json({ success: true, chat_id: chatId, history: processedHistory })
  } catch (err) {
    console.error("Chat yükleme hatası:", err)
    res.status(500).json({ success: false, error: "Sunucu hatası" })
  }
})

app.post("/new_chat", async (req, res) => {
  try {
    const oldChatId = await getCurrentChatId()
    const oldChatHistory = await loadChatHistory(oldChatId)

    await generateAndSaveSummary(oldChatId, oldChatHistory)

    const newChatId = oldChatId + 1
    await setCurrentChatId(newChatId)

    res.json({ success: true, new_chat_id: newChatId })
  } catch (err) {
    console.error("Yeni chat oluşturma hatası:", err)
    res.status(500).json({ success: false, error: "Sunucu hatası" })
  }
})

app.post("/send_message", async (req, res) => {
  try {
    const userMessage = req.body.message
    if (!userMessage || typeof userMessage !== "string" || userMessage.trim().length === 0) {
      return res.status(400).json({ success: false, error: "Mesaj boş olamaz." })
    }

    // Message length limit
    if (userMessage.length > 4000) {
      return res.status(400).json({ success: false, error: "Mesaj çok uzun. Maksimum 4000 karakter." })
    }

    const currentId = await getCurrentChatId()
    const chatHistory = await loadChatHistory(currentId)

    // Kullanıcı mesajını kaydet
    const userMsg = {
      role: "user",
      parts: [userMessage.trim()],
      timestamp: new Date().toISOString(),
    }
    chatHistory.push(userMsg)

    // Model için mesaj oluştur
    const messagesForGemini = chatHistory.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.parts[0] }],
    }))

    const result = await model.generateContent({
      contents: messagesForGemini,
    })

    const response = await result.response
    const aiText = response.text()
    const filteredText = filterResponse(aiText)

    // AI yanıtını işle
    const { processedText, codeBlocks } = processAiResponseForHtml(filteredText)

    // Asistan yanıtını kaydet
    const assistantMsg = {
      role: "model",
      parts: [filteredText],
      timestamp: new Date().toISOString(),
    }
    chatHistory.push(assistantMsg)

    await saveChatHistory(currentId, chatHistory)

    res.json({ success: true, response: processedText, code_blocks: codeBlocks })
  } catch (err) {
    console.error("Mesaj gönderme hatası:", err)

    // Rate limit error handling
    if (err.message && err.message.includes("quota")) {
      return res.status(429).json({ success: false, error: "API kotası aşıldı. Lütfen daha sonra tekrar deneyin." })
    }

    res.status(500).json({ success: false, error: "Sunucu hatası" })
  }
})

// Firebase Auth API'leri
app.post("/register", async (req, res) => {
  const { email, password } = req.body

  // Input validation
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "E-posta ve şifre gereklidir" })
  }

  if (password.length < 6) {
    return res.status(400).json({ success: false, error: "Şifre en az 6 karakter olmalıdır" })
  }

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password)
    res.json({
      success: true,
      user: {
        email: userCredential.user.email,
        uid: userCredential.user.uid,
      },
    })
  } catch (error) {
    console.error("Register error:", error)
    let errorMessage = "Kayıt işlemi başarısız"

    if (error.code === "auth/email-already-in-use") {
      errorMessage = "Bu e-posta adresi zaten kullanımda"
    } else if (error.code === "auth/invalid-email") {
      errorMessage = "Geçersiz e-posta adresi"
    } else if (error.code === "auth/weak-password") {
      errorMessage = "Şifre çok zayıf"
    }

    res.status(400).json({ success: false, error: errorMessage })
  }
})

app.post("/login", async (req, res) => {
  const { email, password } = req.body

  // Input validation
  if (!email || !password) {
    return res.status(400).json({ success: false, error: "E-posta ve şifre gereklidir" })
  }

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password)
    res.json({
      success: true,
      user: {
        email: userCredential.user.email,
        uid: userCredential.user.uid,
      },
    })
  } catch (error) {
    console.error("Login error:", error)
    let errorMessage = "Giriş işlemi başarısız"

    if (error.code === "auth/user-not-found") {
      errorMessage = "Kullanıcı bulunamadı"
    } else if (error.code === "auth/wrong-password") {
      errorMessage = "Yanlış şifre"
    } else if (error.code === "auth/invalid-email") {
      errorMessage = "Geçersiz e-posta adresi"
    } else if (error.code === "auth/too-many-requests") {
      errorMessage = "Çok fazla başarısız deneme. Lütfen daha sonra tekrar deneyin"
    }

    res.status(400).json({ success: false, error: errorMessage })
  }
})

app.post("/reset_password", async (req, res) => {
  const { email } = req.body

  // Input validation
  if (!email) {
    return res.status(400).json({ success: false, error: "E-posta adresi gereklidir" })
  }

  try {
    await sendPasswordResetEmail(auth, email)
    res.json({ success: true, message: "Şifre sıfırlama e-postası gönderildi" })
  } catch (error) {
    console.error("Reset password error:", error)
    let errorMessage = "Şifre sıfırlama başarısız"

    if (error.code === "auth/user-not-found") {
      errorMessage = "Bu e-posta adresi ile kayıtlı kullanıcı bulunamadı"
    } else if (error.code === "auth/invalid-email") {
      errorMessage = "Geçersiz e-posta adresi"
    }

    res.status(400).json({ success: false, error: errorMessage })
  }
})

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ success: false, error: "Sayfa bulunamadı" })
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully")
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully")
  process.exit(0)
})

// Sunucuyu başlat
async function startServer() {
  try {
    await ensureChatDataDir()

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Sunucu http://localhost:${PORT} adresinde çalışıyor`)
      console.log(`📁 Chat data directory: ${CHAT_DATA_DIR}`)
      console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`)
      console.log(`🔥 Firebase Project: ${firebaseConfig.projectId}`)
    })
  } catch (error) {
    console.error("Server başlatma hatası:", error)
    process.exit(1)
  }
}

startServer()