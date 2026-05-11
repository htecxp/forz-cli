import { dispatch, formatError } from '../lib/commands'

dispatch(process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(formatError(e))
    process.exit(1)
  })
