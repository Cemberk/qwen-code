# Uninstall

This fork is built from source, so uninstalling means removing what the build
created.

## Remove the linked `qwen` command

If you linked the CLI with `npm link packages/cli`, unlink it:

```bash
npm uninstall -g @qwen-code/qwen-code
```

## Remove the source checkout

Delete the directory you cloned the repository into. The build output
(`dist/` and each package's `dist/`) lives inside it.

## Remove your configuration and data (optional)

Qwen Code keeps settings, session transcripts and logs under `~/.qwen`. Delete
that directory to remove them:

```bash
rm -rf ~/.qwen
```
