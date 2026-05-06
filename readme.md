# Filer-sync


An offline friendly minimalist scratchpad with sync!


## Requirements

 - Podman / Docker*
    - Pocketbase
 - Python 3 (to serve this static site)

`*` - Update podman commands in `Makefile`


### Pocketbase schema


A collection named `filer` with 3 new textfields (`app_id`, `pane_key`, `content`). And a reasonable api rule for all atleast `@request.auth.id != ""`
