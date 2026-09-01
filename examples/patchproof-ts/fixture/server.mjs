import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

const html = await readFile(fileURLToPath(new URL("index.html", import.meta.url)), "utf8")
const host = process.env.HOST ?? "127.0.0.1"
const port = Number(process.env.PORT ?? 3000)

const state = {
  authorization: "pending",
  auditEvents: 0,
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/favicon.ico") {
    response.writeHead(204).end()
    return
  }

  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(html)
    return
  }

  if (request.method === "GET" && request.url === "/api/case") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(state))
    return
  }

  if (request.method === "POST" && request.url === "/api/approve") {
    state.authorization = "approved"
    // Baseline bug: the screen reports success but the required audit event is
    // never persisted. The follow-up commit fixes exactly this line of behavior.
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(state))
    return
  }

  response.writeHead(404).end()
})

server.listen(port, host, () => {
  console.log(`synthetic claims desk listening on http://${host}:${port}`)
})
