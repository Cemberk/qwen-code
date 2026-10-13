# Uninstall

This fork is built from source, so uninstalling means removing what the build
created.

## Remove the `qwen` command

Delete the script the [Quickstart](../quickstart#add-the-qwen-command)
created:

```bash
rm ~/.local/bin/qwen
```

## Remove the source checkout

Delete the directory you cloned the repository into. The build output
(`dist/` and each package's `dist/`) lives inside it.

## Remove downloaded models (optional)

Models live in the Hugging Face cache. Remove each model's repository with
`/models remove <id>` before you uninstall, or with `hf`:

```bash
hf cache rm model/unsloth/Qwen3.6-35B-A3B-GGUF
```

## Remove your configuration and data (optional)

Qwen Code keeps settings, session transcripts and logs under `~/.qwen`. Delete
that directory to remove them:

```bash
rm -rf ~/.qwen
```
