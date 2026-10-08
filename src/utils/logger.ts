interface LogEntry {
  time: string
  level: string
  msg: string
}

const MAX_ENTRIES = 2000
const entries: LogEntry[] = []
let installed = false

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

function add(level: string, args: unknown[]): void {
  const time = new Date().toISOString().slice(11, 23)
  const msg = args.map(formatArg).join(' ')
  entries.push({ time, level, msg })
  if (entries.length > MAX_ENTRIES) entries.shift()
}

export function installLogger(): void {
  if (installed) return
  installed = true
  const origLog = console.log.bind(console)
  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)
  console.log = (...args: unknown[]) => { add('LOG', args); origLog(...args) }
  console.error = (...args: unknown[]) => { add('ERR', args); origError(...args) }
  console.warn = (...args: unknown[]) => { add('WARN', args); origWarn(...args) }
}

export function getLogText(): string {
  return entries.map((e) => `[${e.time}] [${e.level}] ${e.msg}`).join('\n')
}

export function clearLog(): void {
  entries.length = 0
}