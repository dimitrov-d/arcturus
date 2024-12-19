import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import { Keypair, Transaction, Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import dotenv from 'dotenv';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';
import http from 'http';

dotenv.config();

const userStates: { 
  [chatId: number]: { 
    awaitingPasswordSet?: boolean, 
    awaitingPasswordUnlock?: boolean,
    awaitingTransferRecipient?: boolean,
    awaitingTransferAmount?: boolean,
    transferDetails?: {
      recipient?: string,
      amount?: number
    },
    lastMessageId?: number
  } 
} = {};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Telegram bot is running');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Dummy server running on port ${process.env.PORT || 3000}`);
});

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: true });
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = new Connection(process.env.SOLANA_URL!);

const IV_LENGTH = 16;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
const ENCRYPTION_ALGORITHM = process.env.ENCRYPTION_ALGORITHM;
const AI_AGENT_API_URL = process.env.AI_AGENT_API_URL!;

interface AiAgentResponse {
  response: string;
  output?: { transaction?: string };
  threadId?: string;
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'utf-8'), iv);
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(text: string): string {
  const [iv, encryptedText] = text.split(':');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, Buffer.from(ENCRYPTION_KEY, 'utf-8'), Buffer.from(iv, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedText, 'hex')), decipher.final()]);
  return decrypted.toString();
}

async function isWalletLocked(chatId: number): Promise<boolean> {
  try {
    const result = await db.query('SELECT is_locked FROM user_wallets WHERE telegram_id = $1', [chatId]);
    return result.rows[0]?.is_locked === true;
  } catch (error) {
    console.error('Error checking wallet lock status:', error);
    return true;
  }
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const result = await db.query('SELECT public_key FROM user_wallets WHERE telegram_id = $1', [chatId]);
    if (result.rows.length > 0) {
      bot.sendMessage(chatId, 'You already have a wallet initialized.');
      return;
    }

    const wallet = Keypair.generate();
    const publicKey = wallet.publicKey.toBase58();
    const privateKey = encrypt(Buffer.from(wallet.secretKey).toString('base64'));

    await db.query(
      `INSERT INTO user_wallets (telegram_id, public_key, private_key, is_locked) VALUES ($1, $2, $3, $4)`,
      [chatId, publicKey, privateKey, false]
    );

    bot.sendMessage(
      chatId,
      `Welcome! A dedicated wallet has been created for you.\nPublic Key: \`${publicKey}\``, 
      { 
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'Copy Address', callback_data: `copy_address:${publicKey}` }
          ]]
        }
      }
    );
  } catch (error) {
    console.error('Error during /start:', error instanceof Error ? error.message : 'Unknown error');
    bot.sendMessage(chatId, 'An error occurred while creating your wallet. Please try again.');
  }
});

bot.on('callback_query', async (callbackQuery) => {
  const message = callbackQuery.message;
  const chatId = message!.chat.id;

  if (callbackQuery.data?.startsWith('copy_address:')) {
    const address = callbackQuery.data.split(':')[1];
    
    bot.answerCallbackQuery(callbackQuery.id, { text: 'Address copied!' });
  }
});

bot.onText(/\/checkaddress/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const result = await db.query('SELECT public_key FROM user_wallets WHERE telegram_id = $1', [chatId]);
    const publicKey = result.rows[0]?.public_key;

    if (!publicKey) {
      bot.sendMessage(chatId, 'You do not have a wallet. Use /start to initialize one.');
      return;
    }

    bot.sendMessage(chatId, `Your wallet address is: \`${publicKey}\``, { 
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Copy Address', callback_data: `copy_address:${publicKey}` }
        ]]
      }
    });
  } catch (error) {
    console.error('Error during /checkaddress:', error);
    bot.sendMessage(chatId, 'An error occurred while retrieving your address. Please try again.');
  }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
*Wallet Bot Commands:*

*Wallet Management:*
• /start - Initialize a new Solana wallet
• /lock - Lock your wallet or set a password
• /unlock - Unlock your wallet
• /checkaddress - View your wallet's public address

*Wallet Operations:*
• /balance - Check your wallet balance
• /transfer - Send SOL to another wallet

*Security Features:*
- Set a password to protect your wallet
- Wallet can be locked/unlocked
- Passwords cannot be recovered
- Sensitive messages are automatically deleted
- Each user has a unique, secure Solana wallet

*How to Use:*
1. Start by initializing your wallet with /start
2. Set a password using /lock
3. Use /balance to check funds
4. Use /transfer to send SOL
5. Always keep your password secure!
6. Chat and sign transactions with the AI-agent

*Important Notes:*
- Locked wallets cannot perform transactions
- Your private key is securely encrypted
- Choose a strong, memorable password
- Passwords cannot be recovered!
`;

  bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/lock/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const result = await db.query('SELECT password FROM user_wallets WHERE telegram_id = $1', [chatId]);
    
    if (!result.rows[0]?.password) {
      bot.sendMessage(chatId, 'Please set a password for your wallet by sending your desired password in the next message. Passwords can not be recovered.');
      userStates[chatId] = { awaitingPasswordSet: true };
    } else {
      await db.query('UPDATE user_wallets SET is_locked = $1 WHERE telegram_id = $2', [true, chatId]);
      bot.sendMessage(chatId, 'Your wallet has been locked.');
    }
  } catch (error) {
    console.error('Error during /lock:', error);
    bot.sendMessage(chatId, 'An error occurred while processing your request. Please try again.');
  }
});

bot.onText(/\/unlock/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const result = await db.query('SELECT password FROM user_wallets WHERE telegram_id = $1', [chatId]);
    
    if (!result.rows[0]?.password) {
      bot.sendMessage(chatId, 'You have not set a password yet. Use /lock to set a password first.');
    } else {
      bot.sendMessage(chatId, 'Please enter your wallet password.');
      userStates[chatId] = { awaitingPasswordUnlock: true };
    }
  } catch (error) {
    console.error('Error during /unlock:', error);
    bot.sendMessage(chatId, 'An error occurred while processing your request. Please try again.');
  }
});

bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;

  if (await isWalletLocked(chatId)) {
    bot.sendMessage(chatId, 'Wallet is locked. Please /unlock to use this command.');
    return;
  }

  try {
    const result = await db.query('SELECT public_key FROM user_wallets WHERE telegram_id = $1', [chatId]);
    const publicKey = result.rows[0]?.public_key;

    if (!publicKey) {
      bot.sendMessage(chatId, 'You do not have a wallet. Use /start to initialize one.');
      return;
    }

    const balance = await connection.getBalance(new PublicKey(publicKey));
    bot.sendMessage(chatId, `Your wallet balance is: ${(balance / 1e9).toFixed(2)} SOL`);
  } catch (error) {
    console.error('Error during /balance:', error);
    bot.sendMessage(chatId, 'An error occurred while fetching your balance. Please try again.');
  }
});

bot.onText(/\/transfer/, async (msg) => {
  const chatId = msg.chat.id;

  if (await isWalletLocked(chatId)) {
    bot.sendMessage(chatId, 'Wallet is locked. Please /unlock to use this command.');
    return;
  }

  bot.sendMessage(chatId, 'Please provide the recipient wallet address.');
  userStates[chatId] = { awaitingTransferRecipient: true };
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const messageId = msg.message_id;

  if (!text || text.startsWith('/')) return;

  const state = userStates[chatId];

  if (state) {
    if (state.awaitingTransferRecipient) {
      try {
        if (!PublicKey.isOnCurve(text)) {
          bot.sendMessage(chatId, 'Invalid wallet address. Please provide a valid Solana wallet address.');
          return;
        }
        state.transferDetails = { recipient: text };
        userStates[chatId] = { awaitingTransferAmount: true, transferDetails: state.transferDetails };
        bot.sendMessage(chatId, 'Please enter the amount to transfer (in SOL).');
      } catch (error) {
        console.error('Error handling recipient address:', error);
        bot.sendMessage(chatId, 'An error occurred. Please try again.');
        delete userStates[chatId];
      }
      return;
    }

    if (state.awaitingTransferAmount) {
      try {
        const amount = parseFloat(text);
    
        if (isNaN(amount) || amount <= 0) {
          bot.sendMessage(chatId, 'Invalid amount. Please enter a valid number greater than 0.');
          return;
        }
    
        const result = await db.query('SELECT public_key, private_key FROM user_wallets WHERE telegram_id = $1', [chatId]);
        const privateKey = result.rows[0]?.private_key ? decrypt(result.rows[0].private_key) : null;
        const fromPublicKey = result.rows[0]?.public_key;
    
        if (!privateKey || !fromPublicKey) {
          bot.sendMessage(chatId, 'Wallet details not found.');
          delete userStates[chatId];
          return;
        }
    
        const wallet = Keypair.fromSecretKey(Buffer.from(privateKey, 'base64'));
        const senderPublicKey = new PublicKey(fromPublicKey);
        const balance = await connection.getBalance(senderPublicKey) / 1e9;
    
        const estimatedFee = 0.000005;
        if (balance < amount + estimatedFee) {
          bot.sendMessage(chatId, `Insufficient balance. Your wallet has ${(balance).toFixed(2)} SOL, but you need at least ${(amount + estimatedFee).toFixed(2)} SOL.`);
          delete userStates[chatId];
          return;
        }
    
        const recipientPublicKey = new PublicKey(state.transferDetails!.recipient!);
        const latestBlockhash = await connection.getLatestBlockhash();
    
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: recipientPublicKey,
            lamports: amount * 1_000_000_000,
          })
        );
    
        transaction.recentBlockhash = latestBlockhash.blockhash;
        transaction.feePayer = wallet.publicKey;
    
        transaction.sign(wallet);
    
        const signature = await connection.sendRawTransaction(transaction.serialize());
    
        await connection.confirmTransaction({
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        });
    
        bot.sendMessage(chatId, `Transfer of ${amount} SOL successful! Transaction signature: [${signature}](https://solscan.io/tx/${signature})`, {
          parse_mode: 'Markdown',
        });
    
        delete userStates[chatId];
      } catch (error) {
        console.error('Transfer error:', error);
    
        if (error.logs) {
          console.error('Transaction logs:', error.logs);
        }
    
        bot.sendMessage(chatId, 'An error occurred during the transfer. Please try again.');
        delete userStates[chatId];
      }
      return;
    }
  }

  const deleteSensitiveMessage = async () => {
    try {
      if (state?.lastMessageId) {
        await bot.deleteMessage(chatId, state.lastMessageId);
        delete state.lastMessageId;
      }
    } catch (error) {
      console.error('Error deleting message:', error);
    }
  };

  if (state?.awaitingPasswordSet) {
    try {
      state.lastMessageId = messageId;

      const hashedPassword = await bcrypt.hash(text, 10);
      await db.query('UPDATE user_wallets SET password = $1, is_locked = $2 WHERE telegram_id = $3', [
        hashedPassword,
        true,
        chatId,
      ]);

      await deleteSensitiveMessage();

      bot.sendMessage(chatId, 'Password set successfully. Your wallet is now locked.');
      delete userStates[chatId];
    } catch (error) {
      console.error('Error setting password:', error);
      bot.sendMessage(chatId, 'An error occurred while setting your password. Please try again.');
      await deleteSensitiveMessage();
    }
    return;
  }

  if (state?.awaitingPasswordUnlock) {
    try {
      state.lastMessageId = messageId;

      const result = await db.query('SELECT password FROM user_wallets WHERE telegram_id = $1', [chatId]);
      const hashedPassword = result.rows[0]?.password;

      if (hashedPassword && (await bcrypt.compare(text, hashedPassword))) {
        await db.query('UPDATE user_wallets SET is_locked = $1 WHERE telegram_id = $2', [false, chatId]);
        
        await deleteSensitiveMessage();

        bot.sendMessage(chatId, 'Your wallet has been unlocked successfully.');
        delete userStates[chatId];
      } else {
        await deleteSensitiveMessage();

        bot.sendMessage(chatId, 'Incorrect password. Please try again.');
      }
    } catch (error) {
      console.error('Error unlocking wallet:', error);
      
      await deleteSensitiveMessage();

      bot.sendMessage(chatId, 'An error occurred while unlocking your wallet. Please try again.');
    }
    return;
  }

  try {
    if (await isWalletLocked(chatId)) {
      const aiResponse = 'Wallet is locked. /unlock to finalize the transaction.';
      bot.sendMessage(chatId, aiResponse);
      return;
    }

    const result = await db.query('SELECT thread_id FROM user_wallets WHERE telegram_id = $1', [chatId]);
    const threadId = result.rows[0]?.thread_id || null;

    const response = await fetch(AI_AGENT_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, threadId }),
    });

    const { response: aiResponse, threadId: newThreadId } = await response.json() as AiAgentResponse;

    if (!threadId && newThreadId) {
      await db.query('UPDATE user_wallets SET thread_id = $1 WHERE telegram_id = $2', [newThreadId, chatId]);
    }

    bot.sendMessage(chatId, aiResponse, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error handling message:', error);
    bot.sendMessage(chatId, 'An error occurred. Please try again later.');
  }
});