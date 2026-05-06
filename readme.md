# Filer-sync


An offline friendly minimalist scratchpad with sync!


## Requirements

 - Podman / Docker*
    - Pocketbase
 - Python 3 (to serve this static site)

`*` - Update podman commands in `Makefile`


### Pocketbase schema


A collection named `filer` with 3 new textfields (`app_id`, `pane_key`, `content`). And a reasonable api rule for all atleast `@request.auth.id != ""`


### Nginix Proxy Manager

If you use npm for your pocketbase, update your proxyhost (advanced) rules

```
location / {
    # Hide potential duplicates
    # proxy_hide_header 'Access-Control-Allow-Origin';
    # proxy_hide_header 'Access-Control-Allow-Methods';
    # proxy_hide_header 'Access-Control-Allow-Headers';

    # Force headers with 'always'
    add_header 'Access-Control-Allow-Origin' "$http_origin" always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Authorization, Content-Type, X-Requested-With, Accept, Origin, Access-Control-Request-Private-Network' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;
    add_header 'Access-Control-Allow-Private-Network' 'true' always;

    # Standard Proxy Pass (NPM usually does this, but it was throwing CORS error without this)
    # without this i get cors error
    proxy_pass $forward_scheme://$server:$port;
}
```