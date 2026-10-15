import "server-only"
import { randomBytes } from "node:crypto"
import { SCOPES, googleJson } from "./service-account"

/**
 * Gmail send + drafts as an impersonated Workspace mailbox. gmail.compose
 * covers both messages.send and drafts.create.
 */
export interface MailAttachment {
  filename: string
  contentType: string
  data: Buffer
}

export interface MailMessage {
  from: string
  to: string[]
  cc?: string[]
  replyTo?: string
  subject: string
  html: string
  attachments?: MailAttachment[]
}

/** RFC 2047 encoded-word for non-ASCII header values (e.g. an en dash). */
function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n").trimEnd()
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function buildMime(m: MailMessage): string {
  const boundaryMixed = `mixed_${randomBytes(8).toString("hex")}`
  const boundaryAlt = `alt_${randomBytes(8).toString("hex")}`
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    m.cc?.length ? `Cc: ${m.cc.join(", ")}` : null,
    m.replyTo ? `Reply-To: ${m.replyTo}` : null,
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
  ].filter(Boolean) as string[]

  const alt = [
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(htmlToText(m.html), "utf8").toString("base64")),
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(Buffer.from(m.html, "utf8").toString("base64")),
    `--${boundaryAlt}--`,
  ].join("\r\n")

  if (!m.attachments?.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`, "", alt].join("\r\n")
  }
  const parts = [`--${boundaryMixed}`, `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`, "", alt]
  for (const a of m.attachments) {
    parts.push(
      `--${boundaryMixed}`,
      `Content-Type: ${a.contentType}; name="${encodeHeader(a.filename)}"`,
      `Content-Disposition: attachment; filename="${encodeHeader(a.filename)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      wrap76(a.data.toString("base64")),
    )
  }
  parts.push(`--${boundaryMixed}--`)
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`, "", parts.join("\r\n")].join("\r\n")
}

export async function sendMail(mailbox: string, m: MailMessage): Promise<{ id: string; threadId: string }> {
  if (m.attachments?.length) {
    // Media upload: up to 35 MB per message (the JSON endpoint is far smaller).
    return googleJson(mailbox, [SCOPES.gmailCompose], "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: buildMime(m),
    })
  }
  const raw = Buffer.from(buildMime(m), "utf8").toString("base64url")
  return googleJson(mailbox, [SCOPES.gmailCompose], "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  })
}

export async function createDraft(mailbox: string, m: MailMessage): Promise<{ id: string; message: { id: string } }> {
  if (m.attachments?.length) {
    return googleJson(mailbox, [SCOPES.gmailCompose], "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=media", {
      method: "POST",
      headers: { "content-type": "message/rfc822" },
      body: buildMime(m),
    })
  }
  const raw = Buffer.from(buildMime(m), "utf8").toString("base64url")
  return googleJson(mailbox, [SCOPES.gmailCompose], "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  })
}
