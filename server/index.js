'use strict';

/**
 * Stripe Webhookサーバー
 *
 * - checkout.session.completed を受信
 * - 署名検証（STRIPE_WEBHOOK_SECRET）
 * - 冪等性（processed_events.json で二重送信防止）
 * - 購入商品に応じてZoom登録リンクをメール送信
 * - SendGrid API使用、指数バックオフで最大3回リトライ
 */

require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// 環境変数
const STRIPE_MODE = process.env.STRIPE_MODE || 'test';
const STRIPE_SECRET_KEY = STRIPE_MODE === 'live'
  ? process.env.STRIPE_SECRET_KEY_LIVE
  : process.env.STRIPE_SECRET_KEY_TEST;
const STRIPE_WEBHOOK_SECRET = STRIPE_MODE === 'live'
  ? process.env.STRIPE_WEBHOOK_SECRET_LIVE
  : process.env.STRIPE_WEBHOOK_SECRET_TEST;

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL;
const SUPPORT_FORM_URL = process.env.SUPPORT_FORM_URL;

// Price ID（環境変数から取得）
const PRICE_ID_FULL_DAY = process.env.PRICE_ID_FULL_DAY;
const PRICE_ID_PRACTICAL_AI_ARCHITECTURE = process.env.PRICE_ID_PRACTICAL_AI_ARCHITECTURE;
const PRICE_ID_IMAGE_GEN_AI = process.env.PRICE_ID_IMAGE_GEN_AI;
const PRICE_ID_GOOGLE_HP_GAS = process.env.PRICE_ID_GOOGLE_HP_GAS;

// Firebase Admin初期化
const FIREBASE_CONFIG = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : null;

if (FIREBASE_CONFIG) {
  admin.initializeApp({
    credential: admin.credential.cert(FIREBASE_CONFIG)
  });
} else {
  console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT未設定 - メール認証なしで動作');
}

// データファイルパス
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROCESSED_EVENTS_JSON = path.join(DATA_DIR, 'processed_events.json');
const FAILED_EMAILS_JSON = path.join(DATA_DIR, 'failed_emails.json');
const ZOOM_MEETINGS_JSON = path.join(DATA_DIR, 'zoom_meetings.json');

// Stripeクライアント
const stripe = new Stripe(STRIPE_SECRET_KEY);

// Expressアプリ
const app = express();
const PORT = process.env.WEBHOOK_PORT || 3000;

// 商品名マッピング（price_id -> 正式商品名）
const PRODUCT_NAME_MAP = {
  [PRICE_ID_FULL_DAY]: 'AI FES. 参加チケット（1日通し）',
  [PRICE_ID_PRACTICAL_AI_ARCHITECTURE]: '第２回実務で使えるAI×建築セミナー',
  [PRICE_ID_IMAGE_GEN_AI]: '今使える画像生成AIセミナー（第２回開催）',
  [PRICE_ID_GOOGLE_HP_GAS]: 'Googleサービスでつくる無料HP＆業務自動化（GAS）セミナー（第１回開催）'
};

// Zoom登録リンク送付マッピング（price_id -> Meeting keys）
const ZOOM_LINK_MAP = {
  [PRICE_ID_FULL_DAY]: ['A', 'B', 'C', 'D', 'E', 'F'],
  [PRICE_ID_PRACTICAL_AI_ARCHITECTURE]: ['C', 'F'],
  [PRICE_ID_IMAGE_GEN_AI]: ['D', 'F'],
  [PRICE_ID_GOOGLE_HP_GAS]: ['E', 'F']
};

// Meeting key -> 正式名称
const MEETING_NAME_MAP = {
  'A': 'AI FES. 直近30日：最新AI Newsまとめ（建築業界向け sena流）',
  'B': 'AI FES. 自社プロダクト（COMPASS/SpotPDF/KAKOME）使い方',
  'C': '第２回実務で使えるAI×建築セミナー',
  'D': '今使える画像生成AIセミナー（第２回開催）',
  'E': 'Googleサービスでつくる無料HP＆業務自動化（GAS）セミナー（第１回開催）',
  'F': 'AI FES. プレゼント配布＋最終質問タイム＋AI×建築サークル案内'
};

// ============================================
// アーカイブ動画ページ用設定
// ============================================

const AIFES_SESSIONS = {
  A: { name: '直近30日：最新AI Newsまとめ', youtubeId: 'zspijMjW-tU', duration: '75min' },
  B: { name: '自社プロダクト紹介（COMPASS/SpotPDF/KAKOME）', youtubeId: 'J33xRxt2kiU', duration: '80min' },
  C: { name: '実務で使えるAI×建築セミナー', youtubeId: '4ItAbxrfL84', duration: '145min' },
  D: { name: '今使える画像生成AIセミナー', youtubeId: 'ZyKBkx0IrT8', duration: '90min' },
  E1: { name: 'GAS業務自動化セミナー', youtubeId: '', duration: '50min', comingSoon: '録画トラブルにより、後日公開予定です。お待たせして申し訳ございません。' },
  E2: { name: 'Googleサービスでつくる無料HP', youtubeId: 'fiF6r7ZOUCI', duration: '120min' },
  F: { name: 'プレゼント配布＋最終質問タイム', youtubeId: 'QZ3voPMY7QU', duration: '60min' }
};

// サークルサブスクリプション（アクティブ会員 = フルアクセス）
const CIRCLE_PRODUCT_ID = 'prod_TA2S72xlZ4teEN';

// Price ID -> アーカイブセッションキー
const ARCHIVE_SESSION_MAP = {
  [PRICE_ID_FULL_DAY]: ['A', 'B', 'C', 'D', 'E1', 'E2', 'F'],
  [PRICE_ID_PRACTICAL_AI_ARCHITECTURE]: ['A', 'B', 'C', 'F'],
  [PRICE_ID_IMAGE_GEN_AI]: ['A', 'B', 'D', 'F'],
  [PRICE_ID_GOOGLE_HP_GAS]: ['A', 'B', 'E1', 'E2', 'F']
};

// アーカイブ認証レートリミッター（メールごとに10分間で最大5回）
const archiveRateLimit = new Map();
function checkArchiveRateLimit(email) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10分
  const maxRequests = 30; // テスト中は緩め
  const key = email.toLowerCase().trim();

  if (!archiveRateLimit.has(key)) {
    archiveRateLimit.set(key, []);
  }

  const timestamps = archiveRateLimit.get(key).filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    archiveRateLimit.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  archiveRateLimit.set(key, timestamps);
  return true;
}

/**
 * 処理済みイベントを読み込む
 */
function loadProcessedEvents() {
  if (!fs.existsSync(PROCESSED_EVENTS_JSON)) {
    return new Set();
  }
  const content = fs.readFileSync(PROCESSED_EVENTS_JSON, 'utf8');
  const data = JSON.parse(content);
  return new Set(data.processed || []);
}

/**
 * 処理済みイベントを保存
 */
function saveProcessedEvent(eventId) {
  const processed = loadProcessedEvents();
  processed.add(eventId);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(PROCESSED_EVENTS_JSON, JSON.stringify({
    processed: Array.from(processed),
    updated_at: new Date().toISOString()
  }, null, 2), 'utf8');
}

/**
 * 失敗したメールを記録
 */
function recordFailedEmail(email, productName, error) {
  let failed = [];
  if (fs.existsSync(FAILED_EMAILS_JSON)) {
    const content = fs.readFileSync(FAILED_EMAILS_JSON, 'utf8');
    failed = JSON.parse(content);
  }

  failed.push({
    email,
    product_name: productName,
    error: error.message || String(error),
    timestamp: new Date().toISOString()
  });

  fs.writeFileSync(FAILED_EMAILS_JSON, JSON.stringify(failed, null, 2), 'utf8');
}

/**
 * Zoom Meetingデータを読み込む
 */
function loadZoomMeetings() {
  if (!fs.existsSync(ZOOM_MEETINGS_JSON)) {
    console.error('[エラー] zoom_meetings.json が見つかりません');
    return {};
  }
  const content = fs.readFileSync(ZOOM_MEETINGS_JSON, 'utf8');
  return JSON.parse(content);
}

/**
 * Meeting keyからRegistration URLを取得
 */
function getRegistrationUrl(zoomMeetings, meetingKey) {
  const meetingName = MEETING_NAME_MAP[meetingKey];
  if (!meetingName) return null;

  const meeting = zoomMeetings[meetingName];
  if (!meeting) return null;

  return meeting.registration_url;
}

/**
 * SendGridでメール送信（指数バックオフで最大3回リトライ）
 */
async function sendEmailWithRetry(to, subject, htmlContent, maxRetries = 3) {
  const delays = [1000, 2000, 4000]; // 指数バックオフ

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: FROM_EMAIL },
          subject: subject,
          content: [{ type: 'text/html', value: htmlContent }]
        })
      });

      if (response.ok || response.status === 202) {
        console.log(`[メール送信成功] ${to}`);
        return true;
      }

      const text = await response.text();
      throw new Error(`SendGrid API Error: ${response.status} ${text}`);
    } catch (error) {
      console.error(`[メール送信失敗] attempt ${attempt + 1}/${maxRetries}: ${error.message}`);

      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      } else {
        throw error;
      }
    }
  }
}

/**
 * メール本文を生成
 */
function generateEmailContent(productName, meetingKeys, zoomMeetings) {
  const meetingSections = meetingKeys.map(key => {
    const name = MEETING_NAME_MAP[key];
    const url = getRegistrationUrl(zoomMeetings, key);

    return `
<tr>
  <td style="padding: 16px; border-bottom: 1px solid #e9ecef;">
    <p style="margin: 0 0 8px 0; font-weight: 600;">${name}</p>
    <p style="margin: 0;">
      <a href="${url}" style="color: #007bff; text-decoration: none;">Zoom登録はこちら</a>
    </p>
  </td>
</tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: 'Helvetica Neue', Arial, 'Noto Sans JP', sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #f8f9fa; border-radius: 8px; padding: 32px; margin-bottom: 24px;">
    <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600;">AI FES. 参加情報（Zoom登録リンクのご案内）</h1>
    <p style="margin: 0; color: #666;">ご購入ありがとうございます</p>
  </div>

  <div style="margin-bottom: 24px;">
    <h2 style="font-size: 18px; margin: 0 0 12px 0; font-weight: 600;">ご購入商品</h2>
    <p style="margin: 0; padding: 16px; background: #e9ecef; border-radius: 4px; font-weight: 500;">
      ${productName}
    </p>
  </div>

  <div style="margin-bottom: 24px;">
    <h2 style="font-size: 18px; margin: 0 0 12px 0; font-weight: 600;">Zoom登録リンク</h2>
    <p style="margin: 0 0 16px 0; color: #666;">
      以下のリンクから各セッションに登録してください。
    </p>
    <table style="width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e9ecef; border-radius: 4px;">
      ${meetingSections}
    </table>
  </div>

  <!-- 超重要警告 -->
  <div style="background: linear-gradient(135deg, #dc3545, #c82333); border-radius: 8px; padding: 24px; margin-bottom: 24px; text-align: center;">
    <h3 style="margin: 0 0 12px 0; font-size: 20px; font-weight: bold; color: white;">!! 重要 !!</h3>
    <p style="margin: 0; color: white; font-size: 16px; line-height: 1.6;">
      Zoom登録は<strong>必ずこのメールアドレス</strong>で行ってください。<br>
      <span style="background: white; color: #dc3545; padding: 4px 12px; border-radius: 4px; display: inline-block; margin-top: 8px; font-weight: bold;">
        異なるメールアドレスでは参加できません
      </span>
    </p>
  </div>

  <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
    <h3 style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600; color: #856404;">確認事項</h3>
    <ul style="margin: 0; padding-left: 20px; color: #856404;">
      <li style="margin-bottom: 8px;"><strong>購入メールアドレス ＝ Zoom登録メールアドレス</strong>（必須）</li>
      <li style="margin-bottom: 8px;">登録後、Zoomから専用参加URLがメールで届きます</li>
      <li style="margin-bottom: 8px;">メールアドレスの入力間違いにご注意ください</li>
      <li style="margin-bottom: 0;">アーカイブ動画配布あり（配布方法は後日案内）</li>
    </ul>
  </div>

  <div style="border-top: 1px solid #e9ecef; padding-top: 24px; margin-top: 24px;">
    <p style="margin: 0 0 8px 0; color: #666; font-size: 14px;">
      ご不明な点がございましたら、以下よりお問い合わせください。
    </p>
    <p style="margin: 0;">
      <a href="${SUPPORT_FORM_URL}" style="color: #007bff; text-decoration: none;">お問い合わせフォーム</a>
    </p>
  </div>
</body>
</html>`;
}

/**
 * Webhook: checkout.session.completed を処理
 */
async function handleCheckoutCompleted(session) {
  // line_itemsを取得
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    limit: 100
  });

  // 購入者のメールアドレス
  const customerEmail = session.customer_details?.email || session.customer_email;

  if (!customerEmail) {
    console.error('[エラー] 購入者のメールアドレスが取得できません');
    return;
  }

  // 購入したprice_idを取得
  const purchasedPriceIds = lineItems.data.map(item => item.price?.id).filter(Boolean);

  console.log(`[購入者] ${customerEmail}`);
  console.log(`[購入Price IDs] ${purchasedPriceIds.join(', ')}`);

  // price_idから商品名とMeeting keysを取得
  let productName = null;
  let meetingKeys = new Set();

  for (const priceId of purchasedPriceIds) {
    const name = PRODUCT_NAME_MAP[priceId];
    const keys = ZOOM_LINK_MAP[priceId];

    if (name) {
      productName = name;
    }
    if (keys) {
      keys.forEach(k => meetingKeys.add(k));
    }
  }

  if (!productName || meetingKeys.size === 0) {
    console.log('[情報] 対象外の商品購入のためスキップ');
    return;
  }

  // Fは常に含める（共通）
  meetingKeys.add('F');

  // 順序を保持してソート（A, B, C, D, E, F の順）
  const sortedKeys = Array.from(meetingKeys).sort();

  console.log(`[商品名] ${productName}`);
  console.log(`[Zoom Sessions] ${sortedKeys.join(', ')}`);

  // Zoom Meetingデータを読み込む
  const zoomMeetings = loadZoomMeetings();

  // メール本文を生成
  const emailContent = generateEmailContent(productName, sortedKeys, zoomMeetings);

  // メール送信
  const subject = 'AI FES. 参加情報（Zoom登録リンクのご案内）';

  try {
    await sendEmailWithRetry(customerEmail, subject, emailContent);
  } catch (error) {
    console.error(`[メール送信最終失敗] ${customerEmail}: ${error.message}`);
    recordFailedEmail(customerEmail, productName, error);
  }
}

// Stripe Webhook（raw body必須）
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Webhook] 署名検証失敗:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 冪等性チェック
  const processedEvents = loadProcessedEvents();
  if (processedEvents.has(event.id)) {
    console.log(`[Webhook] 既に処理済み: ${event.id}`);
    return res.json({ received: true, status: 'already_processed' });
  }

  console.log(`[Webhook] イベント受信: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }
      default:
        console.log(`[Webhook] 未処理イベント: ${event.type}`);
        break;
    }

    // 処理済みとして記録
    saveProcessedEvent(event.id);

    return res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] 処理エラー:', err);
    return res.status(500).send('Webhook handler error');
  }
});

// ヘルスチェック
app.get('/healthz', (req, res) => {
  res.send('ok');
});

// AI FES 購入ページ
app.get('/aifes', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI FES. チケット購入</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      padding: 40px 20px;
      color: #333;
    }
    .container {
      max-width: 560px;
      margin: 0 auto;
    }

    /* Header */
    .header {
      background: #1a1a1a;
      color: white;
      padding: 48px 40px;
      text-align: center;
      border-radius: 8px 8px 0 0;
    }
    .header h1 {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: 4px;
      margin-bottom: 8px;
    }
    .header .date {
      font-size: 14px;
      color: #999;
      letter-spacing: 1px;
    }

    /* Content */
    .content {
      background: white;
      padding: 40px;
      border-radius: 0 0 8px 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    /* サークル会員案内 */
    .member-notice {
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 32px;
    }
    .member-notice h3 {
      font-size: 14px;
      font-weight: 600;
      color: #0369a1;
      margin-bottom: 8px;
    }
    .member-notice p {
      font-size: 13px;
      color: #0c4a6e;
      line-height: 1.6;
    }

    /* 注意事項 */
    .notice {
      background: #fafafa;
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 32px;
      font-size: 13px;
      line-height: 1.8;
      color: #666;
    }
    .notice strong {
      color: #333;
    }

    /* セクションタイトル */
    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: #1a1a1a;
      letter-spacing: 2px;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid #eee;
    }

    /* 商品カード */
    .product {
      border: 1px solid #e8e8e8;
      border-radius: 6px;
      padding: 24px;
      margin-bottom: 16px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .product:hover {
      border-color: #1a1a1a;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .product-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .product h3 {
      font-size: 15px;
      font-weight: 600;
      color: #1a1a1a;
      flex: 1;
      padding-right: 16px;
    }
    .product .price {
      font-size: 18px;
      font-weight: 700;
      color: #1a1a1a;
      white-space: nowrap;
    }
    .product .desc {
      font-size: 13px;
      color: #888;
      line-height: 1.5;
      margin-bottom: 16px;
    }
    .product a {
      display: inline-block;
      padding: 12px 28px;
      background: #1a1a1a;
      color: white;
      text-decoration: none;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s;
    }
    .product a:hover {
      background: #333;
    }

    /* 1日通しチケット（おすすめ） */
    .product.featured {
      border: 2px solid #1a1a1a;
      position: relative;
    }
    .product.featured::before {
      content: 'RECOMMEND';
      position: absolute;
      top: -10px;
      left: 20px;
      background: #1a1a1a;
      color: white;
      font-size: 10px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 3px;
      letter-spacing: 1px;
    }

    /* 仕切り */
    .divider {
      height: 1px;
      background: #eee;
      margin: 40px 0;
    }

    /* サークル入会案内 */
    .circle-promo {
      background: linear-gradient(135deg, #1a1a1a, #333);
      border-radius: 8px;
      padding: 32px;
      color: white;
      text-align: center;
    }
    .circle-promo h3 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .circle-promo p {
      font-size: 13px;
      line-height: 1.8;
      opacity: 0.9;
      margin-bottom: 20px;
    }
    .circle-promo .benefits {
      text-align: left;
      background: rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 16px 20px;
      margin-bottom: 20px;
      font-size: 13px;
      line-height: 2;
    }
    .circle-buttons {
      display: flex;
      gap: 12px;
      justify-content: center;
    }
    .circle-promo .btn-secondary {
      display: inline-block;
      padding: 14px 28px;
      background: transparent;
      color: white;
      text-decoration: none;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      border: 1px solid rgba(255,255,255,0.5);
      transition: all 0.2s;
    }
    .circle-promo .btn-secondary:hover {
      background: rgba(255,255,255,0.1);
      border-color: white;
    }
    .circle-promo .btn-primary {
      display: inline-block;
      padding: 14px 28px;
      background: white;
      color: #1a1a1a;
      text-decoration: none;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 600;
      transition: transform 0.2s;
    }
    .circle-promo .btn-primary:hover {
      transform: translateY(-2px);
    }

    /* フッター */
    .footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #eee;
      font-size: 12px;
      color: #999;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>AI FES.</h1>
      <p class="date">2026.1.25 SAT / ONLINE</p>
    </div>

    <div class="content">
      <!-- サークル会員向け -->
      <div class="member-notice">
        <h3>サークル会員の方へ</h3>
        <p>会員様には専用クーポンをメールでお送りしています。<br>メールに記載のコードで無料参加できます。</p>
      </div>

      <!-- 注意事項 -->
      <div class="notice">
        <strong>購入前にご確認ください</strong><br>
        購入時のメールアドレスでZoom登録が必要です。<br>
        異なるメールアドレスでは参加できません。
      </div>

      <!-- チケット一覧 -->
      <h2 class="section-title">TICKETS</h2>

      <div class="product featured">
        <div class="product-header">
          <h3>1日通しチケット</h3>
          <div class="price">¥9,800</div>
        </div>
        <div class="desc">全6プログラム参加可能（10:00〜22:00）</div>
        <a href="https://buy.stripe.com/aFacN7ezX6SV8zfcSrf7i03" target="_blank">購入する</a>
      </div>

      <div class="product">
        <div class="product-header">
          <h3>実務で使えるAI×建築セミナー</h3>
          <div class="price">¥5,000</div>
        </div>
        <div class="desc">AIを建築実務で活用する3時間集中講座</div>
        <a href="https://buy.stripe.com/14A00lezX4KNdTz5pZf7i04" target="_blank">購入する</a>
      </div>

      <div class="product">
        <div class="product-header">
          <h3>画像生成AIセミナー</h3>
          <div class="price">¥4,000</div>
        </div>
        <div class="desc">建築パース制作に使える画像生成AI実践講座</div>
        <a href="https://buy.stripe.com/5kQ9AVcrP1yB5n3aKjf7i05" target="_blank">購入する</a>
      </div>

      <div class="product">
        <div class="product-header">
          <h3>無料HP＆GAS自動化セミナー</h3>
          <div class="price">¥3,000</div>
        </div>
        <div class="desc">Googleサービスで作るHP＆業務自動化</div>
        <a href="https://buy.stripe.com/7sY9AVcrP6SV4iZf0zf7i06" target="_blank">購入する</a>
      </div>

      <!-- 仕切り -->
      <div class="divider"></div>

      <!-- サークル入会案内 -->
      <div class="circle-promo">
        <h3>AI×建築サークルに入会する</h3>
        <p>月額会員になると、AI FES.に無料で参加できます。<br>その他にも特典が盛りだくさん！</p>
        <div class="benefits">
          ✓ AI FES. 無料参加<br>
          ✓ 会員限定Discordコミュニティ<br>
          ✓ 過去セミナーアーカイブ視聴<br>
          ✓ 月額 ¥5,000
        </div>
        <div class="circle-buttons">
          <a href="https://suz-u3n-chu.github.io/AI-Architecture-Circle/" target="_blank" class="btn-secondary">詳細を見る</a>
          <a href="/register" class="btn-primary">入会する</a>
        </div>
      </div>

      <div class="footer">
        ご不明点はお問い合わせください
      </div>
    </div>
  </div>
</body>
</html>
  `;
  res.type('html').send(html);
});

// ============================================
// アーカイブ動画ページ
// ============================================

// フォームデータのパース（webhook rawボディの後に配置）
app.use(express.urlencoded({ extended: true }));

// GET /archive - メール入力フォーム
app.get('/archive', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>AI FES. アーカイブ動画</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0a0a0a 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      color: #e0e0e0;
    }
    .container {
      max-width: 480px;
      width: 100%;
    }
    .card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 48px 40px;
      backdrop-filter: blur(20px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    .logo {
      text-align: center;
      margin-bottom: 40px;
    }
    .logo h1 {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 6px;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .logo .dot {
      color: #6c63ff;
    }
    .logo .subtitle {
      font-size: 13px;
      color: #888;
      letter-spacing: 3px;
      margin-top: 8px;
    }
    .description {
      text-align: center;
      font-size: 14px;
      color: #999;
      line-height: 1.8;
      margin-bottom: 36px;
    }
    .form-group {
      margin-bottom: 24px;
    }
    .form-group label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: #aaa;
      letter-spacing: 2px;
      margin-bottom: 8px;
      text-transform: uppercase;
    }
    .form-group input {
      width: 100%;
      padding: 14px 16px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      color: #fff;
      font-size: 16px;
      outline: none;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    .form-group input::placeholder {
      color: #555;
    }
    .form-group input:focus {
      border-color: #6c63ff;
      box-shadow: 0 0 0 3px rgba(108, 99, 255, 0.15);
    }
    .submit-btn {
      width: 100%;
      padding: 16px;
      background: linear-gradient(135deg, #6c63ff, #4834d4);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 1px;
      cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .submit-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(108, 99, 255, 0.4);
    }
    .submit-btn:active {
      transform: translateY(0);
    }
    .footer {
      text-align: center;
      margin-top: 32px;
      font-size: 12px;
      color: #555;
    }
    .footer a {
      color: #6c63ff;
      text-decoration: none;
    }
    @media (max-width: 520px) {
      .card {
        padding: 36px 24px;
      }
      .logo h1 {
        font-size: 26px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">
        <h1>AI FES<span class="dot">.</span></h1>
        <p class="subtitle">アーカイブ動画</p>
      </div>
      <p class="description">
        チケットをご購入いただいた方は<br>
        購入時のメールアドレスを入力してください。<br>
        認証メールをお送りします。
      </p>
      <div id="step-email">
        <div class="form-group">
          <label>メールアドレス</label>
          <input type="email" id="email-input" placeholder="example@email.com" required autocomplete="email">
        </div>
        <button id="send-link-btn" class="submit-btn" onclick="sendSignInLink()">認証メールを送信</button>
      </div>
      <div id="step-sent" style="display:none; text-align:center;">
        <p style="font-size:48px; margin-bottom:16px;">📧</p>
        <p style="color:#6c63ff; font-weight:600; margin-bottom:12px;">認証メールを送信しました</p>
        <p style="color:#999; font-size:14px; line-height:1.6;">
          メール内のリンクをクリックしてください。<br>
          <span id="sent-email" style="color:#fff;"></span> 宛に送信済み
        </p>
      </div>
      <div id="step-verifying" style="display:none; text-align:center;">
        <p style="font-size:48px; margin-bottom:16px;">⏳</p>
        <p style="color:#6c63ff; font-weight:600;">認証中...</p>
      </div>
      <div id="step-error" style="display:none; text-align:center;">
        <p style="font-size:48px; margin-bottom:16px;">❌</p>
        <p id="error-msg" style="color:#ff6b6b; font-weight:600;"></p>
        <button class="submit-btn" style="margin-top:16px;" onclick="location.reload()">やり直す</button>
      </div>

      <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
      <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
      <script>
        firebase.initializeApp({
          apiKey: "${process.env.FIREBASE_API_KEY || ''}",
          authDomain: "${process.env.FIREBASE_AUTH_DOMAIN || ''}",
          projectId: "${process.env.FIREBASE_PROJECT_ID || ''}"
        });

        // メールリンク認証の完了チェック（リンクから戻ってきた場合）
        if (firebase.auth().isSignInWithEmailLink(window.location.href)) {
          document.getElementById('step-email').style.display = 'none';
          document.getElementById('step-verifying').style.display = 'block';
          
          var email = window.localStorage.getItem('archiveEmail');
          if (!email) {
            email = prompt('確認のためメールアドレスを入力してください');
          }
          
          firebase.auth().signInWithEmailLink(email, window.location.href)
            .then(function(result) {
              return result.user.getIdToken();
            })
            .then(function(idToken) {
              // サーバーにFirebaseトークンを送って購入確認
              var form = document.createElement('form');
              form.method = 'POST';
              form.action = '/archive/verify';
              var tokenInput = document.createElement('input');
              tokenInput.name = 'firebaseToken';
              tokenInput.value = idToken;
              form.appendChild(tokenInput);
              document.body.appendChild(form);
              form.submit();
            })
            .catch(function(err) {
              document.getElementById('step-verifying').style.display = 'none';
              document.getElementById('step-error').style.display = 'block';
              document.getElementById('error-msg').textContent = '認証に失敗しました: ' + err.message;
            });
        }

        function sendSignInLink() {
          var email = document.getElementById('email-input').value.trim();
          if (!email) return;
          
          var btn = document.getElementById('send-link-btn');
          btn.disabled = true;
          btn.textContent = '送信中...';
          
          firebase.auth().sendSignInLinkToEmail(email, {
            url: window.location.origin + '/archive',
            handleCodeInApp: true
          }).then(function() {
            window.localStorage.setItem('archiveEmail', email);
            document.getElementById('step-email').style.display = 'none';
            document.getElementById('step-sent').style.display = 'block';
            document.getElementById('sent-email').textContent = email;
          }).catch(function(err) {
            btn.disabled = false;
            btn.textContent = '認証メールを送信';
            document.getElementById('step-email').style.display = 'none';
            document.getElementById('step-error').style.display = 'block';
            document.getElementById('error-msg').textContent = '送信に失敗しました: ' + err.message;
          });
        }

        document.getElementById('email-input').addEventListener('keydown', function(e) {
          if (e.key === 'Enter') { e.preventDefault(); sendSignInLink(); }
        });
      </script>
    </div>
    <div class="footer">
      <p>&copy; AI Architecture Circle</p>
    </div>
  </div>
</body>
</html>`;
  res.type('html').send(html);
});

// デバッグ用: GET /archive/debug?email=xxx
app.get('/archive/debug', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.json({ error: 'email required' });
  
  const debug = { email, steps: {} };
  
  try {
    // 1. 顧客検索
    const customers = await stripe.customers.list({ email: email, limit: 5 });
    debug.steps.customers = customers.data.map(c => ({ id: c.id, email: c.email }));
    
    // 2. サブスクチェック
    if (customers.data.length > 0) {
      const subs = await stripe.subscriptions.list({ customer: customers.data[0].id, status: 'active', limit: 10 });
      debug.steps.subscriptions = subs.data.map(s => ({
        id: s.id,
        status: s.status,
        items: s.items.data.map(i => ({ product: i.price?.product, price_id: i.price?.id }))
      }));
    }
    
    // 3. Checkout sessions + line items for ALL customers
    debug.steps.checkoutSessions = [];
    for (const cust of customers.data) {
      const sessions = await stripe.checkout.sessions.list({ customer: cust.id, status: 'complete', limit: 20 });
      for (const s of sessions.data) {
        const entry = {
          id: s.id,
          customer_id: cust.id,
          payment_status: s.payment_status,
          customer_email: s.customer_details?.email || s.customer_email,
          line_items: []
        };
        try {
          const li = await stripe.checkout.sessions.listLineItems(s.id, { limit: 10 });
          entry.line_items = li.data.map(i => ({ price_id: i.price?.id, product: i.price?.product, description: i.description }));
        } catch (e) {
          entry.line_items_error = e.message;
        }
        debug.steps.checkoutSessions.push(entry);
      }
    }
    
    // 4. ゲスト購入チェック（直近20件）
    const recent = await stripe.checkout.sessions.list({ status: 'complete', limit: 20 });
    debug.steps.recentMatchingEmail = recent.data
      .filter(s => (s.customer_details?.email || s.customer_email || '').toLowerCase() === email)
      .map(s => ({
        id: s.id,
        payment_status: s.payment_status,
        email: s.customer_details?.email || s.customer_email
      }));
    
    res.json(debug);
  } catch (err) {
    res.json({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
  }
});

// POST /archive/verify - Firebase認証 → 動画ページ
app.post('/archive/verify', async (req, res) => {
  const firebaseToken = req.body.firebaseToken;
  let email;

  if (firebaseToken && FIREBASE_CONFIG) {
    // Firebaseトークン検証
    try {
      const decoded = await admin.auth().verifyIdToken(firebaseToken);
      email = (decoded.email || '').toLowerCase();
    } catch (tokenErr) {
      console.error('[Archive] Firebaseトークン検証エラー:', tokenErr.message);
      return res.type('html').send(generateArchiveErrorPage('認証に失敗しました。もう一度お試しください。'));
    }
  } else {
    // フォールバック: Firebase未設定時は直接メアド（開発用）
    email = (req.body.email || '').trim().toLowerCase();
  }

  // バリデーション
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.type('html').send(generateArchiveErrorPage('有効なメールアドレスを入力してください。'));
  }

  // レートリミットチェック
  if (!checkArchiveRateLimit(email)) {
    return res.status(429).type('html').send(
      generateArchiveErrorPage('リクエスト回数の上限に達しました。しばらく時間をおいてから再度お試しください。')
    );
  }

  try {
    const purchasedSessionKeys = new Set();

    // 1. サークルサブスク会員チェック（アクティブ → フルアクセス）
    let allCustomers = [];
    try {
      const customers = await stripe.customers.list({ email: email, limit: 10 });
      allCustomers = customers.data;
      
      for (const customer of allCustomers) {
        const subscriptions = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'active',
          limit: 100
        });
        for (const sub of subscriptions.data) {
          for (const item of sub.items.data) {
            if (item.price?.product === CIRCLE_PRODUCT_ID) {
              ['A', 'B', 'C', 'D', 'E1', 'E2', 'F'].forEach(k => purchasedSessionKeys.add(k));
              break;
            }
          }
          if (purchasedSessionKeys.size > 0) break;
        }
        if (purchasedSessionKeys.size > 0) break;
      }
    } catch (subErr) {
      console.error('[Archive] サブスクチェックエラー:', subErr.message);
    }

    // 2. チケット購入 or サークル商品購入チェック
    if (purchasedSessionKeys.size === 0) {
      for (const customer of allCustomers) {
        const sessions = await stripe.checkout.sessions.list({
          customer: customer.id,
          status: 'complete',
          limit: 100
        });
        
        for (const session of sessions.data) {
          if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') continue;
          
          try {
            const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
            for (const item of lineItems.data) {
              const priceId = item.price?.id;
              // AI FESチケット購入
              if (priceId && ARCHIVE_SESSION_MAP[priceId]) {
                ARCHIVE_SESSION_MAP[priceId].forEach(key => purchasedSessionKeys.add(key));
              }
            }
          } catch (lineItemErr) {
            console.error(`[Archive] line_items取得エラー (session: ${session.id}):`, lineItemErr.message);
          }
        }
      }

      // 顧客未登録の場合（ゲスト購入）: 直近のセッションからメールで検索
      if (purchasedSessionKeys.size === 0 && allCustomers.length === 0) {
        const recentSessions = await stripe.checkout.sessions.list({
          status: 'complete',
          limit: 100
        });
        
        for (const session of recentSessions.data) {
          const sessionEmail = (session.customer_details?.email || session.customer_email || '').toLowerCase();
          if (sessionEmail !== email) continue;
          if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') continue;
          
          try {
            const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
            for (const item of lineItems.data) {
              const priceId = item.price?.id;
              if (priceId && ARCHIVE_SESSION_MAP[priceId]) {
                ARCHIVE_SESSION_MAP[priceId].forEach(key => purchasedSessionKeys.add(key));
              }
            }
          } catch (lineItemErr) {
            console.error(`[Archive] line_items取得エラー (session: ${session.id}):`, lineItemErr.message);
          }
        }
      }
    }

    if (purchasedSessionKeys.size === 0) {
      return res.type('html').send(
        generateArchiveErrorPage('購入履歴またはサークル会員情報が見つかりませんでした。<br>購入時に使用したメールアドレスをご確認ください。')
      );
    }

    // セッションキーをソートして動画ページを生成
    const sortedKeys = ['A', 'B', 'C', 'D', 'E1', 'E2', 'F'].filter(k => purchasedSessionKeys.has(k));

    return res.type('html').send(generateArchiveVideoPage(sortedKeys));

  } catch (err) {
    console.error('[Archive] Stripe検索エラー:', err.message);
    return res.status(500).type('html').send(
      generateArchiveErrorPage('サーバーエラーが発生しました。しばらく時間をおいてから再度お試しください。')
    );
  }
});

/**
 * アーカイブ動画ページ HTML生成
 */
function generateArchiveVideoPage(sessionKeys) {
  const sessionCards = sessionKeys.map(key => {
    const session = AIFES_SESSIONS[key];
    if (!session) return '';

    const videoContent = session.youtubeId
      ? `<div class="video-wrapper" oncontextmenu="return false">
           <div id="player-${key}"></div>
           <div class="video-overlay" data-player="${key}" oncontextmenu="return false">
             <div class="play-btn">▶</div>
           </div>
         </div>`
      : `<div class="video-placeholder">
           <div class="placeholder-icon">▶</div>
           <p>${session.comingSoon ? '後日公開予定' : '準備中'}</p>
           <span>${session.comingSoon || '動画は近日公開予定です'}</span>
         </div>`;

    return `
    <div class="session-card">
      <div class="session-header">
        <span class="session-badge">${key}</span>
        <div class="session-info">
          <h3>${session.name}</h3>
          <span class="session-duration">${session.duration}</span>
        </div>
      </div>
      ${videoContent}
    </div>`;
  }).join('');

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>AI FES. アーカイブ動画</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif;
      background: linear-gradient(180deg, #0a0a0a 0%, #1a1a2e 30%, #16213e 60%, #0a0a0a 100%);
      min-height: 100vh;
      padding: 40px 20px 60px;
      color: #e0e0e0;
      -webkit-user-select: none;
      -moz-user-select: none;
      -ms-user-select: none;
      user-select: none;
    }

    /* Header */
    .page-header {
      text-align: center;
      margin-bottom: 48px;
      padding-top: 20px;
    }
    .page-header h1 {
      font-size: 36px;
      font-weight: 700;
      letter-spacing: 6px;
      color: #ffffff;
      margin-bottom: 4px;
    }
    .page-header h1 .dot { color: #6c63ff; }
    .page-header .subtitle {
      font-size: 14px;
      color: #888;
      letter-spacing: 3px;
      margin-top: 8px;
    }
    .page-header .session-count {
      display: inline-block;
      margin-top: 16px;
      padding: 6px 20px;
      background: rgba(108, 99, 255, 0.15);
      border: 1px solid rgba(108, 99, 255, 0.3);
      border-radius: 20px;
      font-size: 13px;
      color: #a29bfe;
      letter-spacing: 1px;
    }

    .notice-bar {
      max-width: 800px;
      margin: 0 auto 40px;
      padding: 12px 20px;
      background: rgba(255, 193, 7, 0.08);
      border: 1px solid rgba(255, 193, 7, 0.2);
      border-radius: 8px;
      text-align: center;
      font-size: 13px;
      color: #ffd43b;
    }

    /* Session Cards */
    .sessions-grid {
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 28px;
    }
    .session-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 16px;
      overflow: hidden;
      transition: border-color 0.3s, box-shadow 0.3s;
    }
    .session-card:hover {
      border-color: rgba(108, 99, 255, 0.3);
      box-shadow: 0 4px 24px rgba(108, 99, 255, 0.1);
    }
    .session-header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 20px 24px;
    }
    .session-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      height: 44px;
      padding: 0 12px;
      background: linear-gradient(135deg, #6c63ff, #4834d4);
      border-radius: 10px;
      font-size: 15px;
      font-weight: 700;
      color: white;
      letter-spacing: 1px;
    }
    .session-info {
      flex: 1;
    }
    .session-info h3 {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 4px;
    }
    .session-duration {
      font-size: 12px;
      color: #888;
      letter-spacing: 1px;
    }

    /* Video Embed */
    .video-wrapper {
      position: relative;
      width: 100%;
      padding-top: 56.25%;
      background: #000;
    }
    .video-wrapper iframe {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    .video-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.15);
      transition: background 0.3s;
    }
    .video-overlay.playing {
      background: transparent;
    }
    .video-overlay:hover {
      background: rgba(0,0,0,0.25);
    }
    .video-overlay.playing:hover {
      background: rgba(0,0,0,0.15);
    }
    .play-btn {
      font-size: 48px;
      color: rgba(255,255,255,0.9);
      text-shadow: 0 2px 8px rgba(0,0,0,0.5);
      transition: opacity 0.3s, transform 0.2s;
      pointer-events: none;
    }
    .video-overlay.playing .play-btn {
      opacity: 0;
    }
    .video-overlay.playing:hover .play-btn {
      opacity: 0.8;
    }

    /* Placeholder */
    .video-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 48px 20px;
      background: rgba(0, 0, 0, 0.3);
      text-align: center;
    }
    .placeholder-icon {
      width: 64px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 50%;
      font-size: 24px;
      color: #555;
      margin-bottom: 16px;
    }
    .video-placeholder p {
      font-size: 16px;
      font-weight: 600;
      color: #666;
      margin-bottom: 4px;
    }
    .video-placeholder span {
      font-size: 13px;
      color: #444;
    }

    /* Footer */
    .page-footer {
      max-width: 800px;
      margin: 60px auto 0;
      padding-top: 32px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      text-align: center;
    }
    .page-footer p {
      font-size: 12px;
      color: #555;
      line-height: 2;
    }
    .page-footer a {
      color: #6c63ff;
      text-decoration: none;
    }

    @media (max-width: 600px) {
      body { padding: 24px 12px 40px; }
      .page-header h1 { font-size: 28px; }
      .session-header { padding: 16px; gap: 12px; }
      .session-badge { min-width: 38px; height: 38px; font-size: 13px; }
      .session-info h3 { font-size: 14px; }
    }
  </style>
</head>
<body oncontextmenu="return false" onselectstart="return false" ondragstart="return false">
  <div class="page-header">
    <h1>AI FES<span class="dot">.</span></h1>
    <p class="subtitle">アーカイブ動画</p>
    <div class="session-count">${sessionKeys.length} セッション視聴可能</div>
  </div>

  <div class="notice-bar">
    ⚠ このページのURLの共有はご遠慮ください
  </div>

  <div class="sessions-grid">
    ${sessionCards}
  </div>

  <div class="page-footer">
    <p>
      &copy; AI Architecture Circle<br>
      お問い合わせ: <a href="${SUPPORT_FORM_URL || '#'}">お問い合わせフォーム</a>
    </p>
  </div>

  <script>
    // YouTube IFrame API
    var tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);

    var players = {};
    var videoIds = {${sessionKeys.filter(k => AIFES_SESSIONS[k]?.youtubeId).map(k => `'${k}':'${AIFES_SESSIONS[k].youtubeId}'`).join(',')}};

    function onYouTubeIframeAPIReady() {
      Object.keys(videoIds).forEach(function(key) {
        players[key] = new YT.Player('player-' + key, {
          videoId: videoIds[key],
          playerVars: { rel: 0, modestbranding: 1, disablekb: 1, fs: 1 },
          events: { onStateChange: function(e) { updateOverlay(key, e.data); } }
        });
      });
    }

    function updateOverlay(key, state) {
      var overlay = document.querySelector('[data-player="' + key + '"]');
      if (!overlay) return;
      var btn = overlay.querySelector('.play-btn');
      if (state === YT.PlayerState.PLAYING) {
        btn.textContent = '❚❚';
        overlay.classList.add('playing');
      } else {
        btn.textContent = '▶';
        overlay.classList.remove('playing');
      }
    }

    // オーバーレイクリックで再生/一時停止トグル
    document.querySelectorAll('.video-overlay').forEach(function(overlay) {
      overlay.addEventListener('click', function() {
        var key = this.dataset.player;
        var p = players[key];
        if (!p || !p.getPlayerState) return;
        if (p.getPlayerState() === YT.PlayerState.PLAYING) {
          p.pauseVideo();
        } else {
          p.playVideo();
        }
      });
    });

    // DevTools対策
    document.addEventListener('keydown', function(e) {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i')) || (e.ctrlKey && (e.key === 'u' || e.key === 'U'))) {
        e.preventDefault();
      }
    });
  </script>
</body>
</html>`;
}

/**
 * アーカイブエラーページ HTML生成
 */
function generateArchiveErrorPage(message) {
  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>AI FES. アーカイブ動画</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', Meiryo, sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #0a0a0a 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
      color: #e0e0e0;
    }
    .container {
      max-width: 480px;
      width: 100%;
    }
    .card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 48px 40px;
      backdrop-filter: blur(20px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    .error-icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 107, 107, 0.1);
      border: 1px solid rgba(255, 107, 107, 0.2);
      border-radius: 50%;
      font-size: 28px;
    }
    .card h2 {
      font-size: 18px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 16px;
    }
    .card p {
      font-size: 14px;
      color: #999;
      line-height: 1.8;
      margin-bottom: 32px;
    }
    .back-btn {
      display: inline-block;
      padding: 14px 32px;
      background: linear-gradient(135deg, #6c63ff, #4834d4);
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .back-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 20px rgba(108, 99, 255, 0.4);
    }
    @media (max-width: 520px) {
      .card { padding: 36px 24px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="error-icon">✕</div>
      <h2>購入履歴が見つかりません</h2>
      <p>${message}</p>
      <a href="/archive" class="back-btn">もう一度入力する</a>
    </div>
  </div>
</body>
</html>`;
}

// Vercel用エクスポート
module.exports = app;

// サーバー起動（ローカル開発用）
if (!process.env.VERCEL) {
app.listen(PORT, () => {
  console.log('========================================');
  console.log('Stripe Webhookサーバー');
  console.log('========================================');
  console.log(`[モード] ${STRIPE_MODE.toUpperCase()}`);
  console.log(`[ポート] ${PORT}`);
  console.log(`[Webhook URL] POST /stripe/webhook`);
  console.log('');

  // 設定確認
  const missing = [];
  if (!STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY');
  if (!STRIPE_WEBHOOK_SECRET) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!SENDGRID_API_KEY) missing.push('SENDGRID_API_KEY');
  if (!FROM_EMAIL) missing.push('FROM_EMAIL');
  if (!SUPPORT_FORM_URL) missing.push('SUPPORT_FORM_URL');
  if (!PRICE_ID_FULL_DAY) missing.push('PRICE_ID_FULL_DAY');
  if (!PRICE_ID_PRACTICAL_AI_ARCHITECTURE) missing.push('PRICE_ID_PRACTICAL_AI_ARCHITECTURE');
  if (!PRICE_ID_IMAGE_GEN_AI) missing.push('PRICE_ID_IMAGE_GEN_AI');
  if (!PRICE_ID_GOOGLE_HP_GAS) missing.push('PRICE_ID_GOOGLE_HP_GAS');

  if (missing.length > 0) {
    console.warn('[警告] 以下の環境変数が未設定です:');
    missing.forEach(m => console.warn(`  - ${m}`));
  } else {
    console.log('[設定] すべての環境変数が設定されています');
  }

  console.log('========================================');
});
} // end if (!process.env.VERCEL)
