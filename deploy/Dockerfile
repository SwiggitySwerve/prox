FROM docker.io/library/nginx:1.28-alpine
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/provider-routes.conf /etc/nginx/provider-routes.conf
COPY deploy/provider-discovery.json /usr/share/nginx/html/prox/sources.json
COPY dist/index.html /usr/share/nginx/html/index.html
# Cache-Control is no-store, so nginx would recompress this ~4 MB file on every page load. Keep the
# plain file for clients without gzip; gzip_static serves index.html.gz to the rest.
RUN gzip -9 -k /usr/share/nginx/html/index.html
