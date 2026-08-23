import { getBlobStore } from "./_shared/blob"

const DOCUMENT_STORE = "blog-documents"

export default async (req: Request) => {
  const url = new URL(req.url)
  const id = url.searchParams.get("id")
  if (!id) return new Response("id required", { status: 400 })

  const store = getBlobStore(DOCUMENT_STORE, "strong")
  const raw = await store.get(id, { type: "text" })
  if (!raw) return new Response("Not found", { status: 404 })

  const doc = JSON.parse(raw)
  const buf = Buffer.from(doc.data || "", "base64")
  if (buf.length === 0) return new Response("Empty document", { status: 404 })

  const mime = String(doc.mime || "application/octet-stream")
  const name = String(doc.name || `${id}.bin`)
  const encoded = encodeURIComponent(name)

  return new Response(buf, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename*=UTF-8''${encoded}`,
      "Cache-Control": "no-cache",
    },
  })
}

export const config = { path: "/api/admin-document" }
