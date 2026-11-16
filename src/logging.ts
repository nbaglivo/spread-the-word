import { AsyncLocalStorage } from 'node:async_hooks'
import { configure, getConsoleSink, getJsonLinesFormatter, type LogRecord, type Sink } from '@logtape/logtape'

const jsonLines = getJsonLinesFormatter()

export function formatLine(record: LogRecord): string {
  const { activity: _, ...properties } = record.properties
  return jsonLines({ ...record, properties })
}

export async function setupLogging(sink: Sink = getConsoleSink({ formatter: formatLine })): Promise<void> {
  await configure({
    reset: true,
    contextLocalStorage: new AsyncLocalStorage(),
    sinks: { main: sink },
    loggers: [
      { category: ['stw'], sinks: ['main'], lowestLevel: 'info' },
      { category: ['fedify'], sinks: ['main'], lowestLevel: 'info' },
      { category: ['logtape', 'meta'], sinks: ['main'], lowestLevel: 'warning' },
    ],
  })
}
