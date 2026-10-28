FROM docker.io/library/nginx:1.28-alpine
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/provider-routes.conf /etc/nginx/provider-routes.conf
COPY deploy/provider-discovery.json /usr/share/nginx/html/prox/sources.json
COPY dist/index.html /usr/share/nginx/html/index.html
