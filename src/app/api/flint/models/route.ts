import { NextResponse } from 'next/server'
import { listModels, PROVIDERS, THINKING_LEVELS, DEFAULT_MODEL, DEFAULT_SUBAGENT_MODEL, DEFAULT_AUX_MODEL } from '@/lib/flint/models'

export async function GET() {
  return NextResponse.json({
    models: listModels(),
    providers: PROVIDERS,
    thinkingLevels: THINKING_LEVELS,
    defaults: { model: DEFAULT_MODEL, subagent: DEFAULT_SUBAGENT_MODEL, auxiliary: DEFAULT_AUX_MODEL },
  })
}
