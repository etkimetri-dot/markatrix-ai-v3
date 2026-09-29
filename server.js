require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Fail-fast if critical environment variables are missing
if (!process.env.IG_APP_SECRET || !process.env.IG_VERIFY_TOKEN) {
  console.error('FATAL ERROR: IG_APP_SECRET and IG_VERIFY_TOKEN environment variables are required.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

const APP_SECRET = process.env.IG_APP_SECRET;
const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN;
const MARKATRIX_ID = '17841459614516819';

// Initialize Gemini AI (if API key is provided)
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// --- SOHBET HAFIZASI VE BİLGİ BANKASI ---
// Gerçek bir SaaS uygulamasında bu veriler veritabanında tutulur (MongoDB, Redis vb.)
const userSessions = {}; // { 'senderId': [ history array ] }

const SYSTEM_PROMPT = `
Senin adın Markatrix AI. Sen Markatrix isimli dijital ajansın resmi Instagram müşteri temsilcisisin.

BİLGİ BANKASI (FİYATLAR VE HİZMETLER):
- Markatrix bir sosyal medya yönetimi ve yapay zeka entegrasyon ajansıdır.
- Temel Sosyal Medya Paketi: Aylık 10.000 TL
- Yapay Zeka Destekli Büyüme Paketi: Aylık 15.000 TL
- Web Sitesi Tasarımı: Başlangıç 20.000 TL
- Tüm müşterilerimizle ilk tanışma ve "Ön Görüşme" tamamen ÜCRETSİZDİR.
- Eğer bilgi bankasında olmayan bir hizmet veya fiyat sorulursa uydurma, "Bu konuyu detaylandırmak için ekibimiz size dönüş yapacaktır" de.

KİŞİLİK VE KURALLAR:
1. Son derece profesyonel, net, çözüm odaklı ve kibar ol.
2. SADECE sorulan soruya cevap ver. Gereksiz uzun cümleler kurma.
3. KISA VE ÖZ OL: Cevapların sanki hızlı bir WhatsApp veya DM sohbetindeymişsin gibi aşırı kısa olsun. En fazla 1 veya 2 kısa cümle kur. Paragraf yazma, destan anlatma.
4. EMOJİ KURALI (İNSANSI YAZIM): Cevaplarında MAKSİMUM 1 adet emoji kullan. ÇOK ÖNEMLİ: Cümle sonunda hem nokta (.) hem de emoji yan yana KULLANMA. Gerçek bir insan gibi ya sadece nokta koy, ya da noktayı silip sadece emoji koy.
5. Müşterinin önceki mesajlarını hatırlıyormuş gibi doğal bir sohbet akışı kur.
`;

// Middleware to capture raw body for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// --- OAUTH 2.0 (TEK TIKLA GİRİŞ) SİSTEMİ ---
const FB_CLIENT_ID = '2341013213402646'; // Sizin App ID'niz

// Müşteriyi Facebook Login ekranına yönlendir
app.get('/auth/login', (req, res) => {
  const dynamicRedirectUri = `https://${req.get('host')}/auth/callback`;
  const fbLoginUrl = `https://www.facebook.com/v25.0/dialog/oauth?client_id=${FB_CLIENT_ID}&redirect_uri=${dynamicRedirectUri}&response_type=code&scope=instagram_basic,instagram_manage_messages,pages_show_list,pages_read_engagement`;
  res.redirect(fbLoginUrl);
});

// Facebook'tan dönen kodu alıp Token'a çevir (ve veritabanına kaydet)
app.get('/auth/callback', async (req, res) => {
  const dynamicRedirectUri = `https://${req.get('host')}/auth/callback`;
  const code = req.query.code;
  if (!code) return res.send('Hata: Giriş reddedildi veya kod alınamadı.');

  try {
    const axios = require('axios');
    const fs = require('fs');
    
    // 1. Kodu Access Token'a çevir
    const tokenResponse = await axios.get(`https://graph.facebook.com/v25.0/oauth/access_token?client_id=${FB_CLIENT_ID}&redirect_uri=${dynamicRedirectUri}&client_secret=${process.env.IG_APP_SECRET}&code=${code}`);
    const userAccessToken = tokenResponse.data.access_token;

    // 2. Kullanıcının sahip olduğu Facebook Sayfalarını ve Instagram Hesaplarını bul
    const pagesResponse = await axios.get(`https://graph.facebook.com/v25.0/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userAccessToken}`);
    const pages = pagesResponse.data.data;

    let savedBrands = 0;
    let db = { brands: {} };
    try { db = JSON.parse(fs.readFileSync('./database.json', 'utf8')); } catch (err) {}

    // 3. Bulunan tüm Instagram hesaplarını veritabanına ekle
    for (const page of pages) {
      if (page.instagram_business_account) {
        const igId = page.instagram_business_account.id;
        db.brands[igId] = {
          name: page.name + " (Otomatik Kayıt)",
          access_token: page.access_token, // Sayfa token'ı webhooklarda mesaj atabilmek için gereklidir
          system_prompt: `Sen ${page.name} markasının asistanısın. Müşterilere profesyonel ve kısa cevaplar ver.`
        };
        savedBrands++;
        
        // 4. (Opsiyonel) Sayfayı bizim webhook'umuza otomatik abone yap
        await axios.post(`https://graph.facebook.com/v25.0/${page.id}/subscribed_apps`, 
          { subscribed_fields: ['messages', 'messaging_postbacks'] },
          { headers: { 'Authorization': `Bearer ${page.access_token}` } }
        ).catch(e => console.log('Otomatik webhook aboneliği başarısız (İzin eksik olabilir).', e.message));
      }
    }

    fs.writeFileSync('./database.json', JSON.stringify(db, null, 2));

    if (savedBrands > 0) {
      res.send(`<h1>Tebrikler! 🎉</h1><p>${savedBrands} adet Instagram hesabı sisteme başarıyla bağlandı. Artık yapay zekanız devrede. <a href="/">Panele Dön</a></p>`);
    } else {
      res.send('<h1>Hesap Bulunamadı</h1><p>Facebook girişiniz başarılı ancak bağlı bir Instagram İşletme Hesabı bulunamadı.</p>');
    }

  } catch (error) {
    console.error('OAuth Hatası:', error.response ? error.response.data : error.message);
    res.send('Bir hata oluştu. Lütfen sistem loglarını kontrol edin.');
  }
});

app.use(express.static('public')); // Admin paneli için HTML klasörünü sun

// API: Kayıtlı markaları getir
app.get('/api/brands', (req, res) => {
  const fs = require('fs');
  try {
    const db = JSON.parse(fs.readFileSync('./database.json', 'utf8'));
    res.json(db);
  } catch (err) {
    res.json({ brands: {} });
  }
});

// API: Yeni marka ekle veya güncelle
app.post('/api/brands/:id', (req, res) => {
  const fs = require('fs');
  const brandId = req.params.id;
  const newBrandData = req.body;

  let db = { brands: {} };
  try {
    db = JSON.parse(fs.readFileSync('./database.json', 'utf8'));
  } catch (err) { /* ignore */ }

  db.brands[brandId] = newBrandData;

  fs.writeFileSync('./database.json', JSON.stringify(db, null, 2));
  res.json({ success: true, message: 'Brand updated in database' });
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully.');
    res.status(200).send(challenge);
  } else {
    console.error('Webhook verification failed. Token mismatch.');
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return res.sendStatus(400);

  try {
    const expectedSignature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex')}`;
    const expectedBuffer = Buffer.from(expectedSignature);
    const incomingBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== incomingBuffer.length || !crypto.timingSafeEqual(expectedBuffer, incomingBuffer)) {
      return res.sendStatus(401);
    }
  } catch (err) {
    return res.sendStatus(401);
  }

  res.sendStatus(200);
  const body = req.body;
  
  try {
    if (body.entry && body.entry.length > 0) {
      // SAAS VERİTABANINI YÜKLE
      const fs = require('fs');
      let db = { brands: {} };
      try {
        db = JSON.parse(fs.readFileSync('./database.json', 'utf8'));
      } catch (e) {
        console.log('⚠️ database.json okunamadı veya bulunamadı, varsayılan (tek marka) moda dönülüyor.');
      }

      for (const entry of body.entry) {
        // Hangi markanın (müşterinin) Instagram sayfasına mesaj geldiğini bul
        const pageId = entry.id;
        let brandConfig = db.brands[pageId];

        // Geliştirme kolaylığı için: Eğer veritabanında yoksa, .env'deki ana hesabı (Markatrix) kullan
        if (!brandConfig && pageId === MARKATRIX_ID) {
           brandConfig = {
             name: "Markatrix (Varsayılan)",
             access_token: process.env.IG_ACCESS_TOKEN,
             system_prompt: SYSTEM_PROMPT // Dosyanın üstünde tanımlı olan eski prompt
           };
        } else if (!brandConfig) {
          console.log(`⚠️ Uyarı: ${pageId} ID'li sayfa veritabanımızda bulunamadı (Kayıtsız Müşteri).`);
          continue; // Veritabanında olmayan (para ödemeyen) markalara hizmet verme
        }

        // Markanın kendi Token'ı ve kendi Yapay Zeka Kuralları (Prompt)
        // Eğer veritabanında token boş bırakıldıysa .env'den çek (test amaçlı)
        const BRAND_TOKEN = brandConfig.access_token || process.env.IG_ACCESS_TOKEN;
        const BRAND_PROMPT = brandConfig.system_prompt;

        // --- 1. DM (ÖZEL MESAJ) YAKALAYICISI ---
        if (entry.messaging && entry.messaging.length > 0) {
          for (const messageEvent of entry.messaging) {
            if (messageEvent.message && messageEvent.message.text) {
              const senderId = messageEvent.sender.id;
              const messageText = messageEvent.message.text;
              
              console.log(`\n--- 💬 [${brandConfig.name}] YENİ DM GELDİ ---`);
              console.log(`Gönderen: ${senderId} | Mesaj: "${messageText}"`);

              if (senderId === pageId) {
                console.log('🛑 Kendi DM mesajımız, yoksayılıyor.');
                continue;
              }

              if (genAI && messageText) {
                try {
                  const model = genAI.getGenerativeModel({ 
                    model: "gemini-3.5-flash-lite",
                    systemInstruction: BRAND_PROMPT 
                  });

                  if (!userSessions[senderId]) {
                    userSessions[senderId] = [];
                  }

                  const chat = model.startChat({
                    history: userSessions[senderId]
                  });
                  
                  const result = await chat.sendMessage(messageText);
                  const responseText = result.response.text().trim();
                  
                  userSessions[senderId] = await chat.getHistory();
                  
                  console.log(`✅ [${brandConfig.name}] AI Cevap Üretti:`, responseText);
                  
                  if (BRAND_TOKEN) {
                    const axios = require('axios');
                    await axios.post(`https://graph.instagram.com/v25.0/me/messages`, {
                      recipient: { id: senderId },
                      message: { text: responseText }
                    }, {
                      headers: { 'Authorization': `Bearer ${BRAND_TOKEN}` }
                    });
                    console.log(`🎉 [${brandConfig.name}] DM başarıyla gönderildi.`);
                  }
                } catch (aiError) {
                  console.error('❌ AI DM cevap üretirken hata oluştu:', aiError.message);
                }
              }
            }
          }
        }

        // --- 2. YORUM YAKALAYICISI ---
        if (entry.changes && entry.changes.length > 0) {
          for (const change of entry.changes) {
            if (change.field === 'comments') {
              const comment = change.value;
              console.log(`\n--- 📩 [${brandConfig.name}] YENİ YORUM GELDİ ---`);
              console.log(`Gönderen: ${comment.from ? comment.from.id : 'unknown'} | Metin: "${comment.text}"`);

              if (comment.from && comment.from.id === pageId) {
                console.log('🛑 Kendi yorum cevabımız, yoksayılıyor.');
                continue;
              }

              if (genAI && comment.text) {
                try {
                  const model = genAI.getGenerativeModel({ 
                    model: "gemini-3.5-flash-lite",
                    systemInstruction: BRAND_PROMPT
                  });
                  
                  const prompt = `Yorum: "${comment.text}"\nYukarıdaki yoruma kısa, emojiyi abartmadan (max 1 adet) doğrudan bir yanıt ver. Sadece yanıtı yaz.`;
                  const result = await model.generateContent(prompt);
                  const responseText = result.response.text().trim();
                  
                  console.log(`✅ [${brandConfig.name}] AI Cevap Üretti:`, responseText);
                  
                  if (BRAND_TOKEN) {
                    const axios = require('axios');
                    await axios.post(`https://graph.instagram.com/v25.0/${comment.id}/replies`, {
                      message: responseText 
                    }, {
                      headers: { 'Authorization': `Bearer ${BRAND_TOKEN}` }
                    });
                    console.log(`🎉 [${brandConfig.name}] Yorum cevabı başarıyla gönderildi.`);
                  }
                } catch (aiError) {
                  console.error('❌ AI cevap üretirken hata oluştu:', aiError.message);
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error parsing webhook payload:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server is running on port ${PORT}`);
});
