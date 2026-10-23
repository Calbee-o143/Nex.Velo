 const fastify = require('fastify')({ logger: true });
  const path = require('path');
  const { Readable } = require('stream');
  const fastifyStatic = require('@fastify/static');
  const { BareServer } = require('@mercuryworkshop/bare-mux');
  const { LibcurlTransport } = require('@mercuryworkshop/libcurl-transport');
  const wisp = require('@mercuryworkshop/wisp-js');
  const ytdl = require('@distube/ytdl-core');

  // --- PROXY FIX FOR SCRAMJET IFRAME ERRORS ---
  // This hook intercepts every response and removes headers that block iframes
  fastify.addHook('onResponse', async (request, reply) => {
      // Remove X-Frame-Options so the browser doesn't block the iframe
      if (reply.headers['x-frame-options']) {
          delete reply.headers['x-frame-options'];
      }

      // Modify Content-Security-Policy to allow embedding
      if (reply.headers['content-security-policy']) {
          let csp = reply.headers['content-security-policy'];
          if (csp.includes('frame-ancestors')) {
              csp = csp.replace(/frame-ancestors\s+[^;]+(;|$)/g, 'frame-ancestors *; $1');
          } else {
              csp += '; frame-ancestors *';
          }
          reply.headers['content-security-policy'] = csp;
      }
  });
  // --- END PROXY FIX ---

  // Serve static files from the public directory
  fastify.register(fastifyStatic, {
      root: path.join(__dirname, 'public'),
      prefix: '/',
  });

  // Groq AI Proxy
  fastify.get('/api/groq', async (request, reply) => {
      const key = request.query['key'] || process.env.GROQ_API_KEY;
      if (!key) return reply.status(401).send({ error: 'API Key missing' });

      try {
          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify(request.body)
          });
          const data = await response.json();
          return data;
      } catch (e) {
          return reply.status(500).send({ error: e.message });
      }
  });

  // Music/Audio Streaming Proxy
  fastify.get('/api/stream', async (request, reply) => {
      const url = request.query['url'];
      if (!url) return reply.status(400).send({ error: 'URL missing' });

      try {
          const stream = await ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
          reply.raw.setHeader('Content-Type', 'audio/mpeg');
          return reply.send(stream);
      } catch (e) {
          return reply.status(500).send({ error: e.message });
      }
  });

  // Initialize Bare Server for Scramjet/Unblocking
  const bare = new BareServer({
      transport: new LibcurlTransport(),
  });

  // Integrate Bare Server with Fastify
  fastify.all('/scram/*', async (request, reply) => {
      // This routes traffic to the Bare server for proxying
      return bare.handle(request.raw, reply.raw);
  });

  // Start Server
  const start = async () => {
      try {
  // Start Server
  const start = async () => {
      try {
  // Start Server
  const start = async () => {
      try {
          await fastify.listen({ port: process.env.PORT || 8080, host: '0.0.0.0' });
          console.log('🚀 Nex.Velo Proxy running on port ' + (process.env.PORT || 8080));
      } catch (err) {
          console.error(err);
          process.exit(1);
      }
  };

  start();
