 const fastify = require('fastify')({ logger: true });
  const path = require('path');
  const { Readable } = require('stream');
  const fastifyStatic = require('@fastify/static');
  const { BareServer } = require('@mercuryworkshop/bare-mux');
  const { LibcurlTransport } = require('@mercuryworkshop/libcurl-transport');
  const wisp = require('@mercuryworkshop/wisp-js');
  const ytdl = require('@distube/ytdl-core');

  /**
   * 1. SECURITY HEADER SCRUBBER (THE IFRAME FIX)
   * This hook intercepts every response coming from the proxy and removes
   * the headers that cause the "iframe error" in Scramjet.
   */
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

  /**
   * 2. STATIC FILE SERVING
   * Serves your index.html and the new ai.html from the /public folder.
   */
  fastify.register(fastifyStatic, {
      root: path.join(__dirname, 'public'),
      prefix: '/',
  });

  /**
   * 3. AUTOMATED AI ENDPOINT
   * This allows the frontend to send a user-provided API key
   * and maintain a conversation history.
   */
  fastify.post('/api/chat', async (request, reply) => {
      const { messages, apiKey } = request.body;
      const key = apiKey || process.env.GROQ_API_KEY;

      if (!key) return reply.status(401).send({ error: 'API Key is required' });

      try {
          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                  messages: messages, // Pass conversation history for memory
                  model: "llama3-8b-8192",
                  temperature: 0.7,
              })
          });
          const data = await response.json();
          return data;
      } catch (e) {
          return reply.status(500).send({ error: e.message });
      }
  });

  /**
   * 4. MUSIC/AUDIO STREAMING PROXY
   * Bypasses source restrictions for audio streaming.
   */
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

  /**
   * 5. SCRAMJET / BARE MUX INTEGRATION
   * Handles the core unblocking/proxying logic.
   */
  const bare = new BareServer({
      transport: new LibcurlTransport(),
  });

  // Route all /scram/ traffic to the Bare Server
  fastify.all('/scram/*', async (request, reply) => {
      return bare.handle(request.raw, reply.raw);
  });

  /**
   * 6. SERVER STARTUP
   */
  const start = async () => {
      try {
          // Use PORT environment variable (common for Vercel/Heroku/Railway) or default to 8080
          const port = process.env.PORT || 8080;
          await fastify.listen({ port: port, host: '0.0.0.0' });
          console.log(`\n🚀 Nex.Velo Proxy is LIVE!`);
          console.log(`🌐 URL: http://localhost:${port}`);
          console.log(`🤖 AI Page: http://localhost:${port}/ai.html\n`);
      } catch (err) {
          console.error('❌ Server failed to start:', err);
          process.exit(1);
      }
  };

  start();
