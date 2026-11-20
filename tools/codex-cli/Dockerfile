FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

COPY package.json package-lock.json /opt/codex-cli/
WORKDIR /opt/codex-cli
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && ./node_modules/.bin/codex --version \
    && mkdir -p /home/node/.codex \
    && chown node:node /home/node/.codex \
    && chmod 0700 /home/node/.codex

USER node
WORKDIR /home/node
ENTRYPOINT ["/opt/codex-cli/node_modules/.bin/codex"]
CMD ["login", "status"]
