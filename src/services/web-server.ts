import {inject, injectable} from 'inversify';
import {Client, VoiceChannel} from 'discord.js';
import express from 'express';
import {createServer} from 'http';
import path from 'path';
import {fileURLToPath} from 'url';
import crypto from 'crypto';
import {TYPES} from '../types.js';
import PlayerManager from '../managers/player.js';
import GetSongs from './get-songs.js';
import {STATUS} from './player.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '../../static');
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Simple in-memory rate limiter: max 10 login attempts per 15 minutes per IP
const loginAttempts = new Map<string, {count: number; resetAt: number}>();

@injectable()
export default class WebServer {
  private readonly password: string;
  private readonly port: number;

  constructor(
    @inject(TYPES.Client) private readonly client: Client,
    @inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager,
    @inject(TYPES.Services.GetSongs) private readonly getSongs: GetSongs,
  ) {
    this.password = process.env.WEB_PASSWORD ?? '';
    this.port = parseInt(process.env.WEB_PORT ?? '4000', 10);
  }

  // Stateless HMAC token — survives bot restarts, no server-side storage needed
  private generateToken(): string {
    const timestamp = Date.now().toString();
    const sig = crypto.createHmac('sha256', this.password).update(timestamp).digest('hex');
    return Buffer.from(`${timestamp}.${sig}`).toString('base64url');
  }

  private verifyToken(token: string): boolean {
    try {
      const decoded = Buffer.from(token, 'base64url').toString();
      const dot = decoded.indexOf('.');
      if (dot === -1) return false;
      const timestamp = decoded.slice(0, dot);
      const sig = decoded.slice(dot + 1);
      const expected = crypto.createHmac('sha256', this.password).update(timestamp).digest('hex');
      const sigBuf = Buffer.from(sig, 'hex');
      const expBuf = Buffer.from(expected, 'hex');
      if (sigBuf.length !== expBuf.length) return false;
      if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
      const age = Date.now() - parseInt(timestamp, 10);
      return age >= 0 && age < TOKEN_MAX_AGE_MS;
    } catch {
      return false;
    }
  }

  private checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || entry.resetAt < now) {
      loginAttempts.set(ip, {count: 1, resetAt: now + 15 * 60 * 1000});
      return true;
    }

    if (entry.count >= 10) return false;
    entry.count++;
    return true;
  }

  start(): void {
    if (!this.password) {
      console.warn('WEB_PASSWORD not set — web dashboard disabled.');
      return;
    }

    const app = express();
    createServer(app);

    app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'same-origin');
      next();
    });

    app.use(express.json({limit: '10kb'}));
    app.use(express.static(STATIC_DIR));

    const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token || !this.verifyToken(token)) {
        res.status(401).json({error: 'Unauthorized'});
        return;
      }

      next();
    };

    app.post('/api/login', (req, res) => {
      const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown');
      if (!this.checkRateLimit(ip)) {
        res.status(429).json({error: 'Too many attempts. Try again in 15 minutes.'});
        return;
      }

      const {password} = req.body as {password?: string};
      if (password === this.password) {
        res.json({token: this.generateToken()});
      } else {
        res.status(401).json({error: 'Wrong password'});
      }
    });

    app.get('/api/guilds', requireAuth, (_req, res) => {
      res.json([...this.client.guilds.cache.values()].map(g => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL(),
      })));
    });

    app.get('/api/guilds/:guildId/channels', requireAuth, (req, res) => {
      const guild = this.client.guilds.cache.get(req.params.guildId);
      if (!guild) { res.status(404).json({error: 'Guild not found'}); return; }
      res.json([...guild.channels.cache.values()]
        .filter(c => c.isVoiceBased())
        .map(c => ({id: c.id, name: c.name})));
    });

    app.get('/api/guilds/:guildId/status', requireAuth, (req, res) => {
      const player = this.playerManager.get(req.params.guildId);
      const current = player.getCurrent();
      res.json({
        status: player.status,
        position: player.getPosition(),
        current: current ? {
          title: current.title,
          artist: current.artist,
          length: current.length,
          thumbnailUrl: current.thumbnailUrl,
        } : null,
        queue: player.getQueue().map((s, i) => ({
          index: i,
          title: s.title,
          artist: s.artist,
          length: s.length,
          thumbnailUrl: s.thumbnailUrl,
        })),
      });
    });

    app.post('/api/guilds/:guildId/play', requireAuth, async (req, res) => {
      const {query, channelId} = req.body as {query?: string; channelId?: string};
      if (!query || !channelId) { res.status(400).json({error: 'query and channelId are required'}); return; }

      const guild = this.client.guilds.cache.get(req.params.guildId);
      if (!guild) { res.status(404).json({error: 'Guild not found'}); return; }

      const channel = guild.channels.cache.get(channelId);
      if (!channel?.isVoiceBased()) { res.status(400).json({error: 'Invalid voice channel'}); return; }

      try {
        const [songs] = await this.getSongs.getSongs(query, 50, false);
        if (songs.length === 0) { res.status(404).json({error: 'No songs found'}); return; }

        const player = this.playerManager.get(req.params.guildId);
        if (!player.voiceConnection) await player.connect(channel as VoiceChannel);

        const wasIdle = player.getCurrent() === null || player.status === STATUS.IDLE;
        for (const song of songs) {
          player.add({...song, addedInChannelId: channelId, requestedBy: 'Web Dashboard'});
        }

        if (wasIdle) await player.play();
        res.json({success: true, added: songs.length});
      } catch (error: unknown) {
        res.status(500).json({error: error instanceof Error ? error.message : 'Unknown error'});
      }
    });

    app.post('/api/guilds/:guildId/pause', requireAuth, (req, res) => {
      try { this.playerManager.get(req.params.guildId).pause(); res.json({success: true}); }
      catch (error: unknown) { res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'}); }
    });

    app.post('/api/guilds/:guildId/resume', requireAuth, async (req, res) => {
      try { await this.playerManager.get(req.params.guildId).play(); res.json({success: true}); }
      catch (error: unknown) { res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'}); }
    });

    app.post('/api/guilds/:guildId/skip', requireAuth, async (req, res) => {
      try { await this.playerManager.get(req.params.guildId).forward(1); res.json({success: true}); }
      catch (error: unknown) { res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'}); }
    });

    app.post('/api/guilds/:guildId/stop', requireAuth, (req, res) => {
      try { this.playerManager.get(req.params.guildId).disconnect(); res.json({success: true}); }
      catch (error: unknown) { res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'}); }
    });

    app.get('*', (_req, res) => { res.sendFile(path.join(STATIC_DIR, 'index.html')); });

    app.listen(this.port, () => { console.log(`🌐 Web dashboard on port ${this.port}`); });
  }
}
