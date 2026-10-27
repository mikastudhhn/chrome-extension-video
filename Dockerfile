# Pinned by digest (node 24.22.1, Alpine). Update tag and digest together:
# docker buildx imagetools inspect node:<version>-alpine
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node extension/protocol.js extension/runtime-errors.js ./extension/
COPY --chown=node:node demo ./demo
USER node
EXPOSE 8787
# BusyBox wget costs a few hundred KB per check; a second Node process ~60 MB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -T 3 -O /dev/null http://127.0.0.1:8787/health || exit 1
CMD ["node", "server/index.js"]
