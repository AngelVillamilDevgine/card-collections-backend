# mysql2 es JavaScript puro, así que alpine alcanza: no hay nada que compilar.
FROM node:22-alpine

WORKDIR /app

# Las dependencias en su propia capa: mientras el package-lock no cambie, esta capa
# se reusa y el build tarda segundos en vez de minutos.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY bin ./bin

# node:alpine ya trae un usuario "node" sin privilegios. Correr como root adentro
# del contenedor no aporta nada y suma superficie.
USER node

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Que el healthcheck lo haga el propio Node: así la imagen no necesita curl ni wget.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/servidor.js"]
