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

@injectable()
export default class WebServer {
  private readonly tokens = new Set<string>();
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

  start(): void {
    if (!this.password) {
      console.warn('WEB_PASSWORD not set — web dashboard disabled.');
      return;
    }

    const app = express();
    const server = createServer(app);

    app.use(express.json());
    app.use(express.static(STATIC_DIR));

    const requireAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token || !this.tokens.has(token)) {
        res.status(401).json({error: 'Unauthorized'});
        return;
      }

      next();
    };

    app.post('/api/login', (req, res) => {
      const {password} = req.body as {password?: string};
      if (password === this.password) {
        const token = crypto.randomUUID();
        this.tokens.add(token);
        res.json({token});
      } else {
        res.status(401).json({error: 'Wrong password'});
      }
    });

    app.get('/api/guilds', requireAuth, (_req, res) => {
      const guilds = [...this.client.guilds.cache.values()].map(g => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL(),
      }));
      res.json(guilds);
    });

    app.get('/api/guilds/:guildId/channels', requireAuth, (req, res) => {
      const guild = this.client.guilds.cache.get(req.params.guildId);
      if (!guild) {
        res.status(404).json({error: 'Guild not found'});
        return;
      }

      const channels = [...guild.channels.cache.values()]
        .filter(c => c.isVoiceBased())
        .map(c => ({id: c.id, name: c.name}));
      res.json(channels);
    });

    app.get('/api/guilds/:guildId/status', requireAuth, (req, res) => {
      const player = this.playerManager.get(req.params.guildId);
      const current = player.getCurrent();
      res.json({
        status: player.status,
        statusLabel: STATUS[player.status],
        position: player.getPosition(),
        current: current ? {
          title: current.title,
          artist: current.artist,
          length: current.length,
          thumbnailUrl: current.thumbnailUrl,
          requestedBy: current.requestedBy,
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
      if (!query || !channelId) {
        res.status(400).json({error: 'query and channelId are required'});
        return;
      }

      const guild = this.client.guilds.cache.get(req.params.guildId);
      if (!guild) {
        res.status(404).json({error: 'Guild not found'});
        return;
      }

      const channel = guild.channels.cache.get(channelId);
      if (!channel?.isVoiceBased()) {
        res.status(400).json({error: 'Invalid voice channel'});
        return;
      }

      try {
        const [songs] = await this.getSongs.getSongs(query, 50, false);
        if (songs.length === 0) {
          res.status(404).json({error: 'No songs found'});
          return;
        }

        const player = this.playerManager.get(req.params.guildId);
        if (!player.voiceConnection) {
          await player.connect(channel as VoiceChannel);
        }

        const wasIdle = player.getCurrent() === null || player.status === STATUS.IDLE;

        for (const song of songs) {
          player.add({...song, addedInChannelId: channelId, requestedBy: 'Web Dashboard'});
        }

        if (wasIdle) {
          await player.play();
        }

        res.json({success: true, added: songs.length});
      } catch (error: unknown) {
        res.status(500).json({error: error instanceof Error ? error.message : 'Unknown error'});
      }
    });

    app.post('/api/guilds/:guildId/pause', requireAuth, (req, res) => {
      try {
        this.playerManager.get(req.params.guildId).pause();
        res.json({success: true});
      } catch (error: unknown) {
        res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'});
      }
    });

    app.post('/api/guilds/:guildId/resume', requireAuth, async (req, res) => {
      try {
        await this.playerManager.get(req.params.guildId).play();
        res.json({success: true});
      } catch (error: unknown) {
        res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'});
      }
    });

    app.post('/api/guilds/:guildId/skip', requireAuth, async (req, res) => {
      try {
        await this.playerManager.get(req.params.guildId).forward(1);
        res.json({success: true});
      } catch (error: unknown) {
        res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'});
      }
    });

    app.post('/api/guilds/:guildId/stop', requireAuth, (req, res) => {
      try {
        this.playerManager.get(req.params.guildId).disconnect();
        res.json({success: true});
      } catch (error: unknown) {
        res.status(400).json({error: error instanceof Error ? error.message : 'Unknown error'});
      }
    });

    app.get('*', (_req, res) => {
      res.sendFile(path.join(STATIC_DIR, 'index.html'));
    });

    server.listen(this.port, () => {
      console.log(`🌐 Web dashboard running on port ${this.port}`);
    });
  }
}
