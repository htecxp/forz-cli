import { dispatch, formatError, UsageError } from '../lib/commands'

// exitCode, not exit(): exit() can cut off stdout still draining into a pipe.
dispatch(process.argv.slice(2)).catch((e) => {
  console.error(formatError(e))
  process.exitCode = e instanceof UsageError ? 2 : 1
})
