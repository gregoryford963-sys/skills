#!/usr/bin/env bun
/**
 * send-inbox.ts — Send a paid x402 inbox message to another agent
 * Usage: bun run send-inbox.ts <recipientBtcAddress> <recipientStxAddress> "<message>"
 *
 * Uses CLIENT_PRIVATE_KEY from .env for signing (Stacks key).
 * Builds a sponsored sBTC transfer via x402 payment protocol.
 */

import {
  makeContractCall,
  uintCV,
  principalCV,
  noneCV,
  PostConditionMode,
} from "@stacks/transactions";
import {
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentResponse,
  X402_HEADERS,
} from "./src/lib/utils/x402-protocol.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SENDER_ADDRESS = "SP3GXCKM4AB5EB1KJ8V5QSTR1XMTW3R142VQS2NVW";
const PRIVATE_KEY = process.env.CLIENT_PRIVATE_KEY;
const SBTC_CONTRACT = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const INBOX_BASE = "https://aibtc.com/api/inbox";

if (!PRIVATE_KEY) {
  console.error(JSON.stringify({ error: "CLIENT_PRIVATE_KEY not set in environment" }));
  process.exit(1);
}

const [, , recipientBtcAddress, recipientStxAddress, content] = process.argv;

if (!recipientBtcAddress || !recipientStxAddress || !content) {
  console.error(
    JSON.stringify({
      error: "Usage: bun run send-inbox.ts <recipientBtcAddress> <recipientStxAddress> '<message>'",
    })
  );
  process.exit(1);
}

if (content.length > 500) {
  console.error(JSON.stringify({ error: "Message content exceeds 500 character limit" }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const inboxUrl = `${INBOX_BASE}/${recipientBtcAddress}`;
const body = {
  toBtcAddress: recipientBtcAddress,
  toStxAddress: recipientStxAddress,
  content,
};

console.log(`Sending to ${recipientBtcAddress} (${recipientStxAddress})...`);
console.log(`Message: ${content}`);

// Step 1: POST without payment to get 402 challenge
const initialRes = await fetch(inboxUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

if (initialRes.status !== 402) {
  const text = await initialRes.text();
  if (initialRes.ok) {
    console.log(JSON.stringify({ success: true, message: "Sent (no payment required)", response: text }));
    process.exit(0);
  }
  console.error(JSON.stringify({ error: `Expected 402, got ${initialRes.status}: ${text}` }));
  process.exit(1);
}

// Step 2: Parse payment requirements
const paymentHeader = initialRes.headers.get("payment-required");
if (!paymentHeader) {
  console.error(JSON.stringify({ error: "402 response missing payment-required header" }));
  process.exit(1);
}

const paymentRequired = decodePaymentRequired(paymentHeader);
if (!paymentRequired?.accepts?.length) {
  console.error(JSON.stringify({ error: "No accepted payment methods in 402 response" }));
  process.exit(1);
}

const accept = paymentRequired.accepts[0];
const amount = BigInt(accept.amount);
console.log(`Payment required: ${amount} sats to ${accept.payTo}`);

// Step 3: Get current nonce (NONCE_OVERRIDE env sets explicit nonce)
const nonceRes = await fetch(
  `https://api.mainnet.hiro.so/v2/accounts/${SENDER_ADDRESS}?proof=0`
);
const accountInfo = await nonceRes.json() as { nonce: number };
const nonce = process.env.NONCE_OVERRIDE ? BigInt(process.env.NONCE_OVERRIDE) : BigInt(accountInfo.nonce);
console.log(`Using nonce: ${nonce}`);

// Step 4: Build sponsored sBTC transfer (relay pays gas)
const [contractAddress, contractName] = SBTC_CONTRACT.split(".");

const transaction = await makeContractCall({
  contractAddress,
  contractName,
  functionName: "transfer",
  functionArgs: [
    uintCV(amount),
    principalCV(SENDER_ADDRESS),
    principalCV(accept.payTo),
    noneCV(),
  ],
  senderKey: PRIVATE_KEY,
  network: "mainnet",
  postConditionMode: PostConditionMode.Allow,
  fee: 0n,
  sponsored: true,
  nonce,
});

const txHex = "0x" + transaction.serialize();
console.log(`Transaction built (${txHex.length} chars)`);

// Step 5: Encode payment payload
const paymentSignature = encodePaymentPayload({
  x402Version: 2,
  resource: paymentRequired.resource,
  accepted: accept,
  payload: { transaction: txHex },
});

// Step 6: Send with payment header
const finalRes = await fetch(inboxUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    [X402_HEADERS.PAYMENT_SIGNATURE]: paymentSignature,
  },
  body: JSON.stringify(body),
});

const responseText = await finalRes.text();
let responseData: unknown;
try {
  responseData = JSON.parse(responseText);
} catch {
  responseData = { raw: responseText };
}

if (finalRes.status === 201 || finalRes.status === 200) {
  const settlementHeader = finalRes.headers.get(X402_HEADERS.PAYMENT_RESPONSE);
  const settlement = decodePaymentResponse(settlementHeader);
  const txid = settlement?.transaction;

  console.log(
    JSON.stringify({
      success: true,
      message: "Message delivered",
      recipient: { btcAddress: recipientBtcAddress, stxAddress: recipientStxAddress },
      contentLength: content.length,
      inbox: responseData,
      ...(txid && { payment: { txid, amount: `${amount} sats sBTC` } }),
    }, null, 2)
  );
  process.exit(0);
}

console.error(
  JSON.stringify({ error: `Delivery failed (${finalRes.status}): ${responseText}` })
);
process.exit(1);
