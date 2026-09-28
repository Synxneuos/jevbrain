// ================================================================
// JEV BRAIN — AUTONOMOUS DISCORD AGENT WARDEN & SECURITY SENTINEL
// ================================================================
// Features:
// 1. Rogue Mod & Unauthorized Launch Shield (Deletes unauthorized launch announcements,
//    strips mod roles from rogue mods, DMs server owner instantly).
// 2. Strict Anti-Attachment / Anti-Image Protocol (Normal members can only send text).
// 3. Strict Anti-Link / Anti-Phishing Protocol (No external links allowed for regular members).
// 4. Autonomous Scam/FUD Firewall with 12-Hour Timeout.
// 5. Unpin Guard (Unpins unauthorized announcements).
// 6. Automated Role & #verify-here Channel Setup.
// 7. On-chain Verified Token Holder Role Synchronization.
// ================================================================

import { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, AuditLogEvent } from 'discord.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of envContent.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch {}

export const OFFICIAL_TOKEN_CA = (process.env.TOKEN_CONTRACT_ADDRESS || 'AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump').trim();

// Master Developer Identity
export const DEVELOPER_USERNAME = 'synxneuos';
export const DEVELOPER_USER_ID = '1551685204119126028';

// Target Server Configuration
export const DISCORD_CONFIG = {
  get clientId() { return (process.env.DISCORD_CLIENT_ID || '1551686988145491978').trim(); },
  get clientSecret() { return (process.env.DISCORD_CLIENT_SECRET || '').trim(); },
  get botToken() { return (process.env.DISCORD_BOT_TOKEN || '').trim(); },
  get guildId() { return (process.env.DISCORD_GUILD_ID || '1551685785432883332').trim(); },
  get developerUsername() { return (process.env.DISCORD_DEVELOPER_USERNAME || DEVELOPER_USERNAME).trim(); },
  get developerUserId() { return (process.env.DISCORD_DEVELOPER_USER_ID || DEVELOPER_USER_ID).trim(); },
  get officialCA() { return OFFICIAL_TOKEN_CA; },
  get verifyUrl() { return process.env.SITE_URL ? `${process.env.SITE_URL}/verify.html` : 'http://localhost:3333/verify.html'; }
};

export function isDeveloper(userOrMember, guild) {
  if (!userOrMember) return false;
  const id = userOrMember.id || userOrMember.user?.id;
  const username = userOrMember.username || userOrMember.user?.username || '';
  if (guild && id === guild.ownerId) return true;
  if (id === DEVELOPER_USER_ID) return true;
  if (username.toLowerCase() === DEVELOPER_USERNAME.toLowerCase()) return true;
  return false;
}

// 2 Unique Thematic Moderation Roles + 5 Holding Tier Roles
export const SERVER_ROLES = [
  // High-Court Authority
  {
    name: 'Neural Arbiter',
    color: 0x7C3AED, // Electric Purple
    hoist: true,
    permissions: [
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ViewAuditLog,
      PermissionsBitField.Flags.ManageRoles
    ]
  },
  // Field Security Guard
  {
    name: 'Agent Warden',
    color: 0x0284C7, // Cyan Blue
    hoist: true,
    permissions: [
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.ViewAuditLog
    ]
  },
  // Tier 5 Token Holder
  {
    name: 'Dynasty Magnate',
    color: 0xF59E0B, // Amber Gold
    hoist: true,
    permissions: []
  },
  // Tier 4 Token Holder
  {
    name: 'Syndicate Director',
    color: 0x10B981, // Emerald Green
    hoist: true,
    permissions: []
  },
  // Tier 3 Token Holder
  {
    name: 'Principal Partner',
    color: 0x6366F1, // Indigo
    hoist: false,
    permissions: []
  },
  // Tier 2 Token Holder
  {
    name: 'Charter Associate',
    color: 0x64748B, // Slate
    hoist: false,
    permissions: []
  },
  // Tier 1 Token Holder
  {
    name: 'Reserve Initiate',
    color: 0x71717A, // Zinc
    hoist: false,
    permissions: []
  },
  // Base Verified Role
  {
    name: 'Verified Token Holder',
    color: 0x059669, // Forest Green
    hoist: false,
    permissions: []
  },
  // Human Verified Role (Unlocks general community chat)
  {
    name: 'Verified Member',
    color: 0x10B981, // Emerald Green
    hoist: false,
    permissions: []
  }
];

// Rogue Launch Announcement Patterns
const ROGUE_LAUNCH_PATTERNS = [
  /dev\s+(is\s+)?(launching|dropping|deploying|releasing)/i,
  /new\s+(token|ca|contract|pump|coin)/i,
  /stealth\s+launch/i,
  /presale(\s+live)?/i,
  /fair\s+launch/i,
  /airdrop(\s+live|\s+claim|\s+now)/i,
  /migration\s+(to|live)/i,
  /pump\.fun\/(?!AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump)[a-zA-Z0-9]{32,44}/i
];

// Scam & Malicious Phishing Patterns
const SCAM_PATTERNS = [
  /\b(scam|fake|rug|honeypot|drainer|phishing)\b/i,
  /claim\s+your\s+tokens/i,
  /connect\s+wallet\s+to\s+claim/i,
  /dm\s+(me\s+)?for\s+(support|help)/i,
  /seed\s+phrase|private\s+key/i
];

// Link URL Regex
const URL_REGEX = /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+|t\.me\/[^\s]+)/i;

export class JevDiscordBot {
  constructor(config = DISCORD_CONFIG) {
    this.config = config;
    this.client = null;
    this.guild = null;
  }

  ensureClient() {
    if (!this.client) {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildVoiceStates
        ],
        partials: [Partials.Message, Partials.Channel]
      });
      this.setupListeners();
    }
    return this.client;
  }

  async start() {
    if (!this.config.botToken) {
      console.warn('[DiscordBot] No botToken configured.');
      return;
    }
    try {
      this.ensureClient();
      await this.client.login(this.config.botToken);
      console.log(`[DiscordBot] ✓ Logged in as ${this.client.user.tag}`);
    } catch (err) {
      console.error('[DiscordBot] Login failed:', err.message);
    }
  }

  async stop() {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
      this.guild = null;
    }
  }

  setupListeners() {
    if (!this.client) return;
    this.client.on('error', (err) => {
      console.warn('[DiscordBot] Gateway/WebSocket connection notice:', err.message || err);
    });
    this.client.once('clientReady', async () => {
      console.log(`[DiscordBot] Sentinel Active. Connected to Discord Gateway.`);
      await this.initGuild();
    });

    // Automatically initialize when invited to target guild in real time
    this.client.on('guildCreate', async (guild) => {
      console.log(`[DiscordBot] ✓ Joined guild: "${guild.name}" (${guild.id})! Initializing roles and verification channels...`);
      this.guild = guild;
      await this.ensureRolesExist();
      await this.setupServerChannels();
    });

    // Real-time message interceptor (Firewall)
    this.client.on('messageCreate', async (message) => {
      await this.handleMessage(message);
    });

    // Pinned announcement guardian
    this.client.on('channelPinsUpdate', async (channel) => {
      await this.handlePinUpdate(channel);
    });

    // Anti-Channel Creation Sentinel (Only Developer synxneuos can create channels)
    this.client.on('channelCreate', async (channel) => {
      await this.handleChannelCreate(channel);
    });

    // Anti-Voice Sentinel (Voice calls and voice channels strictly disabled)
    this.client.on('voiceStateUpdate', async (oldState, newState) => {
      await this.handleVoiceStateUpdate(oldState, newState);
    });

    // Official Channel Safeguard (Preserves permanent invite link to #verify-here)
    this.client.on('channelDelete', async (channel) => {
      await this.handleChannelDelete(channel);
    });

    // Instant 1-Click Human Verification Button Handler
    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton()) return;
      if (interaction.customId === 'verify_human_btn') {
        try {
          const member = interaction.member;
          if (!member) {
            await interaction.reply({ content: '❌ Could not find your member profile. Please try again.', ephemeral: true });
            return;
          }

          const roles = await interaction.guild.roles.fetch();
          const verifiedRole = roles.find(r => r.name.toLowerCase() === 'verified member')
            || roles.find(r => r.name.toLowerCase() === 'verified token holder');

          if (!verifiedRole) {
            await interaction.reply({ content: '❌ Verification role is initializing. Please try again in 5 seconds.', ephemeral: true });
            return;
          }

          if (member.roles.cache.has(verifiedRole.id)) {
            await interaction.reply({
              content: '✔ **You are already verified!** You have full access to `#general-chat` and community discussions.',
              ephemeral: true
            });
            return;
          }

          await member.roles.add(verifiedRole, 'Jev Brain: 1-Click Human Verification Gate Passed');
          await interaction.reply({
            content: '🎉 **Human Verification Successful!**\n\nWelcome to **Jev Brain Official Discord**! All community discussion channels (`#general-chat`, `#model-routing`) are now unlocked for you. Enjoy chatting!',
            ephemeral: true
          });
          console.log(`[DiscordBot] ✓ Human verified & role granted to: ${interaction.user.tag} (${interaction.user.id})`);
        } catch (err) {
          console.error('[DiscordBot] Human verify button error:', err.message);
          await interaction.reply({ content: `❌ Verification error: ${err.message}`, ephemeral: true }).catch(() => {});
        }
      }
    });
  }

  async initGuild() {
    try {
      if (this.config.guildId) {
        this.guild = await this.client.guilds.fetch(this.config.guildId).catch(() => null);
      }
      if (!this.guild && this.client.guilds.cache.size > 0) {
        this.guild = this.client.guilds.cache.first();
      }
      if (!this.guild) {
        const userGuilds = await this.client.guilds.fetch().catch(() => null);
        if (userGuilds && userGuilds.size > 0) {
          const firstOAuthGuild = userGuilds.first();
          this.guild = await firstOAuthGuild.fetch().catch(() => null);
        }
      }
      if (!this.guild) {
        console.warn(`[DiscordBot] Guild not found. Bot is not yet invited to any server.`);
        return;
      }

      console.log(`[DiscordBot] ✓ Successfully managing Guild: "${this.guild.name}" (ID: ${this.guild.id})`);
      await this.ensureRolesExist();
      await this.setupServerChannels();
    } catch (err) {
      console.error('[DiscordBot] Init guild error:', err.message);
    }
  }

  async ensureRolesExist() {
    if (!this.guild) return;
    try {
      const existingRoles = await this.guild.roles.fetch();
      for (const roleDef of SERVER_ROLES) {
        const found = existingRoles.find(r => r.name.toLowerCase() === roleDef.name.toLowerCase());
        if (!found) {
          console.log(`[DiscordBot] Creating server role: "${roleDef.name}"...`);
          await this.guild.roles.create({
            name: roleDef.name,
            color: roleDef.color,
            hoist: roleDef.hoist,
            permissions: roleDef.permissions,
            reason: 'Jev Brain Automated Role Initialization'
          });
        }
      }
      // Enforce zero-trust restrictions on @everyone role guild-wide
      if (this.guild.roles.everyone) {
        await this.guild.roles.everyone.setPermissions([
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AddReactions,
          PermissionsBitField.Flags.ChangeNickname,
          PermissionsBitField.Flags.UseApplicationCommands
        ], 'Enforce Sentinel Zero-Trust Baseline for @everyone').catch(() => {});
      }
      console.log('[DiscordBot] ✓ All server roles and zero-trust permissions active.');
    } catch (err) {
      console.error('[DiscordBot] Role creation error:', err.message);
    }
  }

  async setupServerChannels() {
    if (!this.guild) return;
    try {
      const roles = await this.guild.roles.fetch();
      const everyoneRole = this.guild.roles.everyone;
      const verifiedRole = roles.find(r => r.name.toLowerCase() === 'verified token holder');
      const arbiterRole = roles.find(r => r.name.toLowerCase() === 'neural arbiter');
      const wardenRole = roles.find(r => r.name.toLowerCase() === 'agent warden');
      const tierRoles = roles.filter(r => [
        'dynasty magnate',
        'syndicate director',
        'principal partner',
        'charter associate',
        'reserve initiate'
      ].includes(r.name.toLowerCase()));

      const channels = await this.guild.channels.fetch();

      // Clean up any unconstrained or voice channels/categories
      for (const [, chan] of channels) {
        if (!chan) continue;
        if (chan.name.toLowerCase() === 'general' && chan.type === ChannelType.GuildText) {
          await chan.delete('Remove unconstrained default #general channel').catch(() => {});
        }
        if (chan.name.toLowerCase() === 'text channels' && chan.type === ChannelType.GuildCategory) {
          await chan.delete('Remove unconstrained Text Channels category').catch(() => {});
        }
        if (chan.name.toLowerCase().includes('voice channels') && chan.type === ChannelType.GuildCategory) {
          await chan.delete('Remove unconstrained Voice Channels category').catch(() => {});
        }
        if (chan.type === ChannelType.GuildVoice || chan.type === ChannelType.GuildStageVoice) {
          await chan.delete('Purge voice channel: Voice is strictly disabled').catch(() => {});
        }
      }

      // 1. CATEGORY: 🛡️ VERIFICATION & GOVERNANCE (Visible to everyone, READ-ONLY, No Channel Creation, No Voice)
      let govCategory = channels.find(c => c && c.type === ChannelType.GuildCategory && c.name.includes('VERIFICATION'));
      const govOverwrites = [
        {
          id: everyoneRole.id,
          allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
          deny: [
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.SendMessagesInThreads,
            PermissionsBitField.Flags.CreatePublicThreads,
            PermissionsBitField.Flags.CreatePrivateThreads,
            PermissionsBitField.Flags.AddReactions,
            PermissionsBitField.Flags.CreateInstantInvite,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.ManageChannels
          ]
        }
      ];

      if (!govCategory) {
        govCategory = await this.guild.channels.create({
          name: '🛡️ VERIFICATION & GOVERNANCE',
          type: ChannelType.GuildCategory,
          permissionOverwrites: govOverwrites,
          reason: 'Jev Brain Automated Category Setup'
        });
      } else {
        await govCategory.permissionOverwrites.set(govOverwrites).catch(() => {});
      }

      // #verify-here
      let verifyChan = channels.find(c => c && (c.name === 'verify-here' || c.name === 'token-verify'));
      if (!verifyChan) {
        console.log('[DiscordBot] Creating #verify-here channel...');
        verifyChan = await this.guild.channels.create({
          name: 'verify-here',
          parent: govCategory.id,
          topic: '1-Click Human Verification Gateway — Click to Unlock Community Channels',
          reason: 'Automated verification channel setup'
        });
      }

      // Ensure fresh Human Verification card is active
      let needsPost = true;
      try {
        const msgs = await verifyChan.messages.fetch({ limit: 10 });
        for (const msg of msgs.values()) {
          if (msg.author.id === this.client.user.id) {
            const hasHumanBtn = msg.components?.some(row => 
              row.components?.some(b => b.customId === 'verify_human_btn')
            );
            if (hasHumanBtn) {
              needsPost = false;
            } else {
              await msg.delete().catch(() => {});
            }
          }
        }
      } catch (e) {}

      if (needsPost) {
        const embed = new EmbedBuilder()
          .setTitle('✻ Jev Brain — Human Verification')
          .setDescription(
            `Welcome to **Jev Brain Official Discord**.\n\n` +
            `To protect our community against automated spam and raid bots, **Human Verification is required** before accessing community discussion channels.\n\n` +
            `**How to Verify:**\n` +
            `Click the green **"Verify as Human"** button below. Verification is instant and unlocks **#general-chat** immediately!`
          )
          .setColor(0x10B981)
          .setFooter({ text: 'Jev Brain Security Sentinel • Instant 1-Click Verification' });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('verify_human_btn')
            .setLabel('✅ Verify as Human')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setLabel('Server Rules & Policy ↗')
            .setStyle(ButtonStyle.Link)
            .setURL(this.config.verifyUrl.replace('verify.html', 'rules.html'))
        );

        await verifyChan.send({ embeds: [embed], components: [row] });
      }

      // #rules-and-policy
      let rulesChan = channels.find(c => c && (c.name === 'rules-and-policy' || c.name === 'server-rules'));
      if (!rulesChan) {
        console.log('[DiscordBot] Creating #rules-and-policy channel...');
        rulesChan = await this.guild.channels.create({
          name: 'rules-and-policy',
          parent: govCategory.id,
          topic: 'Official Discord Rules, Security Policies & Moderation Hierarchy',
          reason: 'Automated rules channel setup'
        });

        const rulesEmbed = new EmbedBuilder()
          .setTitle('🛡️ Jev Brain Official Rules & Security Policies')
          .setDescription(
            `**1. Rogue Moderator & Unauthorized Launch Shield (Zero Tolerance):**\n` +
            `Any claim of "dev launching new token", stealth launch, unapproved contract address, or unauthorized pinned announcement will trigger **immediate role revocation** and an alert DM to the Server Owner.\n\n` +
            `**2. Text-Only Communication:**\n` +
            `Regular members cannot send images, media, stickers, or file uploads. Only text is permitted.\n\n` +
            `**3. Anti-Link / Anti-Phishing:**\n` +
            `External links, Discord invites, and Telegram links are blocked for regular members.\n\n` +
            `**4. 12-Hour Scam / FUD Timeout:**\n` +
            `Prohibited terms (*scam, fake, rug, honeypot, drainer*) trigger immediate deletion and an automatic **12-Hour Timeout**.\n\n` +
            `**5. Moderation Roles:**\n` +
            `• **👑 Neural Arbiter**: High-Court Executive Authority (Ban, Kick, Roles, Lockdown).\n` +
            `• **🛡️ Agent Warden**: Field Security Guard (Kick, 12h Timeout, Message Moderation).\n\n` +
            `Full Policy & Details: ${this.config.verifyUrl.replace('verify.html', 'rules.html')}`
          )
          .setColor(0x7C3AED)
          .setFooter({ text: 'Jev Brain Autonomous Security • 24/7 Always Active' });

        await rulesChan.send({ embeds: [rulesEmbed] });
      }

      // #official-contract
      let caChan = channels.find(c => c && (c.name === 'official-contract' || c.name === 'token-info'));
      if (!caChan) {
        console.log('[DiscordBot] Creating #official-contract channel...');
        caChan = await this.guild.channels.create({
          name: 'official-contract',
          parent: govCategory.id,
          topic: 'Official Solana Contract Address for $JEVBRAIN',
          reason: 'Automated contract channel setup'
        });

        const caEmbed = new EmbedBuilder()
          .setTitle('✻ Official Token Contract Address')
          .setDescription(
            `**Token:** $JEVBRAIN\n` +
            `**Blockchain:** Solana (SPL Token)\n` +
            `**Contract Address:**\n` +
            `\`\`\`\n${this.config.officialCA}\n\`\`\`\n` +
            `*Always verify this exact contract address. Jev Brain will NEVER stealth-drop or launch secondary unannounced tokens.*`
          )
          .setColor(0x10B981)
          .setFooter({ text: 'Verified Contract Security • Solana Mainnet' });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('View on DexScreener ↗')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://dexscreener.com/solana/${this.config.officialCA}`)
        );

        await caChan.send({ embeds: [caEmbed], components: [row] });
      }

      // 2. CATEGORY: ✻ COMMUNITY & AGENTS (COMPLETELY HIDDEN FOR @everyone; ONLY VERIFIED CAN VIEW & SEND)
      let commCategory = channels.find(c => c && c.type === ChannelType.GuildCategory && c.name.includes('COMMUNITY'));
      const commOverwrites = [
        {
          id: everyoneRole.id,
          deny: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.CreateInstantInvite,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.ManageChannels
          ]
        }
      ];

      const verifiedMemberRole = roles.find(r => r.name.toLowerCase() === 'verified member');
      const verifiedHolderRole = roles.find(r => r.name.toLowerCase() === 'verified token holder');

      if (verifiedMemberRole) {
        commOverwrites.push({
          id: verifiedMemberRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ],
          deny: [
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.CreateInstantInvite,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.ManageChannels
          ]
        });
      }
      if (verifiedHolderRole) {
        commOverwrites.push({
          id: verifiedHolderRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ],
          deny: [
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak,
            PermissionsBitField.Flags.ManageChannels
          ]
        });
      }
      if (arbiterRole) {
        commOverwrites.push({
          id: arbiterRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageMessages
          ],
          deny: [
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak
          ]
        });
      }
      if (wardenRole) {
        commOverwrites.push({
          id: wardenRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageMessages
          ],
          deny: [
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.Connect,
            PermissionsBitField.Flags.Speak
          ]
        });
      }
      for (const [, tierRole] of tierRoles) {
        commOverwrites.push({
          id: tierRole.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ]
        });
      }

      if (!commCategory) {
        commCategory = await this.guild.channels.create({
          name: '✻ COMMUNITY & AGENTS',
          type: ChannelType.GuildCategory,
          permissionOverwrites: commOverwrites,
          reason: 'Jev Brain Automated Category Setup'
        });
      } else {
        await commCategory.permissionOverwrites.set(commOverwrites).catch(() => {});
      }

      // #general-chat
      let chatChan = channels.find(c => c && c.name === 'general-chat');
      if (!chatChan) {
        await this.guild.channels.create({
          name: 'general-chat',
          parent: commCategory.id,
          topic: 'General community chat (Human verified members)',
          reason: 'Automated chat channel setup'
        });
      }

      // #model-routing
      let modelChan = channels.find(c => c && c.name === 'model-routing');
      if (!modelChan) {
        await this.guild.channels.create({
          name: 'model-routing',
          parent: commCategory.id,
          topic: 'Discussions on the 513 AI models, latencies, and tier quotas',
          reason: 'Automated model channel setup'
        });
      }

      // Sync permissions across children
      const refreshed = await this.guild.channels.fetch();
      for (const [, chan] of refreshed) {
        if (!chan) continue;
        if (chan.parentId === commCategory?.id || chan.parentId === govCategory?.id) {
          await chan.lockPermissions().catch(() => {});
        }
      }

      console.log('[DiscordBot] ✓ All server channels and categories verified and active.');
    } catch (err) {
      console.error('[DiscordBot] Channels setup error:', err.message);
    }
  }

  async ensureVerifyChannel() {
    return this.setupServerChannels();
  }

  async handleMessage(message) {
    // Ignore bot messages and DMs
    if (message.author.bot || !message.guild) return;

    const content = message.content || '';
    const member = message.member;
    const isOwner = isDeveloper(message.author, message.guild);
    const isMod = member && (
      member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.roles.cache.some(r => r.name === 'Neural Arbiter' || r.name === 'Agent Warden')
    );

    // ================================================================
    // RULE 0: UNVERIFIED USERS CANNOT SEND ANY MESSAGES ANYWHERE
    // ================================================================
    const isVerified = member && member.roles.cache.some(r => [
      'verified member',
      'verified token holder',
      'dynasty magnate',
      'syndicate director',
      'principal partner',
      'charter associate',
      'reserve initiate'
    ].includes(r.name.toLowerCase()));

    if (!isVerified && !isOwner && !isMod) {
      try {
        await message.delete();
        const warn = await message.channel.send(`🔒 <@${message.author.id}>, human verification is strictly required to chat. Please click the verify button in the **#verify-here** channel.`);
        setTimeout(() => warn.delete().catch(() => {}), 4000);
        return;
      } catch (err) {
        console.error('[DiscordBot] Error deleting unverified message:', err.message);
      }
    }

    // ================================================================
    // RULE 1: ROGUE MOD / UNAUTHORIZED TOKEN LAUNCH SHIELD
    // ================================================================
    const isRogueLaunch = ROGUE_LAUNCH_PATTERNS.some(regex => regex.test(content));
    // Any unapproved contract address (other than official AxwSUU...)
    const hasUnapprovedCA = /[1-9A-HJ-NP-Za-km-z]{32,44}/.test(content) && !content.includes(this.config.officialCA);

    if ((isRogueLaunch || hasUnapprovedCA) && !isOwner) {
      try {
        await message.delete();
        console.warn(`[DEFENSE-TRIGGERED] Rogue Token Announcement intercepted from ${message.author.tag} in #${message.channel.name}`);

        // If author has mod privileges, strip them immediately!
        if (isMod) {
          const modRoles = member.roles.cache.filter(r => 
            r.name === 'Neural Arbiter' || 
            r.name === 'Agent Warden' || 
            r.permissions.has(PermissionsBitField.Flags.Administrator) ||
            r.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
            r.permissions.has(PermissionsBitField.Flags.KickMembers)
          );

          if (modRoles.size > 0) {
            await member.roles.remove(modRoles, 'Agent Warden: Unauthorized Token Launch / Rogue Moderator Action Detected');
            console.log(`[DEFENSE-TRIGGERED] Stripped ${modRoles.size} moderation role(s) from rogue mod: ${message.author.tag}`);
          }
        }

        // Send alert DM to Server Owner immediately!
        await this.notifyOwner({
          title: '🚨 CRITICAL SECURITY ALERT: Rogue Launch Intercepted',
          color: 0xEF4444,
          fields: [
            { name: 'User', value: `${message.author.tag} (<@${message.author.id}>)` },
            { name: 'Channel', value: `#${message.channel.name}` },
            { name: 'Reason', value: 'Unauthorized Token Launch / Unapproved Contract Address Detected' },
            { name: 'Message Content', value: `\`\`\`${content.slice(0, 800)}\`\`\`` },
            { name: 'Action Taken', value: isMod ? 'Message Deleted + Moderator Roles STRIPPED instantly.' : 'Message Deleted.' }
          ]
        });

        // Temporary channel warning
        const warn = await message.channel.send(`🛡️ **Agent Warden:** Unauthorized token launch / contract announcements are strictly prohibited. Message removed and action reported to Server Owner.`);
        setTimeout(() => warn.delete().catch(() => {}), 6000);
        return;
      } catch (err) {
        console.error('[DiscordBot] Error handling rogue launch:', err.message);
      }
    }

    // ================================================================
    // RULE 2: SCAM / FUD AUTO-FILTER WITH 12-HOUR TIMEOUT
    // ================================================================
    const isScam = SCAM_PATTERNS.some(regex => regex.test(content));
    if (isScam && !isOwner) {
      try {
        await message.delete();
        // 12-hour timeout = 12 * 60 * 60 * 1000 ms
        const timeoutMs = 12 * 60 * 60 * 1000;
        await member.timeout(timeoutMs, 'Agent Warden Firewall: Prohibited Scam/FUD Keywords');

        await this.notifyOwner({
          title: '⚠️ Scam / FUD Offender Muted (12 Hours)',
          color: 0xF59E0B,
          fields: [
            { name: 'User', value: `${message.author.tag} (<@${message.author.id}>)` },
            { name: 'Channel', value: `#${message.channel.name}` },
            { name: 'Duration', value: '12 Hours Timeout' },
            { name: 'Flagged Content', value: `\`\`\`${content.slice(0, 500)}\`\`\`` }
          ]
        });

        const warn = await message.channel.send(`🔇 **Agent Warden:** <@${message.author.id}> has been muted for **12 Hours** for posting prohibited scam/FUD keywords.`);
        setTimeout(() => warn.delete().catch(() => {}), 6000);
        return;
      } catch (err) {
        console.error('[DiscordBot] Error applying scam timeout:', err.message);
      }
    }

    // ================================================================
    // RULE 3: REGULAR MEMBERS RESTRICTION — TEXT ONLY (NO ATTACHMENTS/IMAGES)
    // ================================================================
    if (!isMod && !isOwner) {
      if (message.attachments.size > 0) {
        try {
          await message.delete();
          const warn = await message.channel.send(`⚠️ <@${message.author.id}>, media and file attachments are restricted to verified moderators. Only text is permitted.`);
          setTimeout(() => warn.delete().catch(() => {}), 4000);
          return;
        } catch (err) {}
      }

      // ================================================================
      // RULE 4: REGULAR MEMBERS RESTRICTION — NO LINKS ALLOWED
      // ================================================================
      if (URL_REGEX.test(content)) {
        try {
          await message.delete();
          const warn = await message.channel.send(`⚠️ <@${message.author.id}>, external links are prohibited to protect members against phishing.`);
          setTimeout(() => warn.delete().catch(() => {}), 4000);
          return;
        } catch (err) {}
      }
    }
  }

  async handlePinUpdate(channel) {
    try {
      const pins = await channel.messages.fetchPinned();
      for (const msg of pins.values()) {
        const isOwner = isDeveloper(msg.author, channel.guild);
        const isRogue = ROGUE_LAUNCH_PATTERNS.some(r => r.test(msg.content));
        if (isRogue && !isOwner) {
          await msg.unpin();
          await msg.delete();
          await this.notifyDeveloper({
            title: '🚨 CRITICAL: Unauthorized Pinned Message Removed',
            color: 0xEF4444,
            fields: [
              { name: 'Channel', value: `#${channel.name}` },
              { name: 'Author', value: `${msg.author.tag} (<@${msg.author.id}>)` },
              { name: 'Content', value: `\`\`\`${msg.content.slice(0, 500)}\`\`\`` },
              { name: 'Action Taken', value: 'Unpinned and deleted automatically.' }
            ]
          });
        }
      }
    } catch (err) {
      console.error('[DiscordBot] Pin check error:', err.message);
    }
  }

  /**
   * Anti-Channel Creation Sentinel:
   * Strictly blocks anyone except Developer synxneuos from creating channels/categories.
   */
  async handleChannelCreate(channel) {
    if (!channel.guild) return;
    try {
      // Brief pause to allow Discord audit log entry to register
      await new Promise(r => setTimeout(r, 600));
      const auditLogs = await channel.guild.fetchAuditLogs({
        type: AuditLogEvent.ChannelCreate,
        limit: 1
      }).catch(() => null);

      const entry = auditLogs?.entries?.first();
      const executor = entry?.executor;
      const isDev = isDeveloper(executor, channel.guild) || (executor && executor.id === this.client?.user?.id);

      if (!isDev) {
        console.warn(`[DEFENSE-TRIGGERED] Unauthorized channel creation intercepted: "${channel.name}" (Type: ${channel.type}) by ${executor?.tag || 'Unknown'}`);

        // 1. Immediately delete the unauthorized channel
        await channel.delete('Unauthorized channel creation blocked: Only Developer synxneuos can create channels').catch(() => {});

        // 2. If executor has any moderation/admin roles, strip them immediately
        if (executor && channel.guild) {
          const member = await channel.guild.members.fetch(executor.id).catch(() => null);
          if (member) {
            const modRoles = member.roles.cache.filter(r =>
              r.name === 'Neural Arbiter' ||
              r.name === 'Agent Warden' ||
              r.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
              r.permissions.has(PermissionsBitField.Flags.Administrator)
            );
            if (modRoles.size > 0) {
              await member.roles.remove(modRoles, 'Agent Warden: Unauthorized Channel Creation Attempt').catch(() => {});
              console.log(`[DEFENSE-TRIGGERED] Stripped mod roles from rogue user: ${executor.tag}`);
            }
          }
        }

        // 3. Notify Developer synxneuos
        await this.notifyDeveloper({
          title: '🚨 CRITICAL DEFENSE: Unauthorized Channel Blocked',
          color: 0xEF4444,
          fields: [
            { name: 'Channel Attempted', value: `\`${channel.name}\` (Type: ${channel.type})` },
            { name: 'Created By', value: executor ? `${executor.tag} (<@${executor.id}>)` : 'Unknown' },
            { name: 'Action Taken', value: 'Channel deleted immediately. Offender roles stripped.' },
            { name: 'Developer Lock', value: 'Channel creation is locked to developer `synxneuos` only.' }
          ]
        });
      }
    } catch (err) {
      console.error('[DiscordBot] handleChannelCreate error:', err.message);
    }
  }

  /**
   * Anti-Voice Sentinel:
   * Voice channels, stage channels, and voice calls are strictly disabled.
   */
  async handleVoiceStateUpdate(oldState, newState) {
    if (!newState.guild) return;
    const channel = newState.channel;
    if (!channel) return;

    const member = newState.member;
    if (!member) return;

    if (isDeveloper(member, newState.guild)) return; // Developer permitted

    try {
      console.warn(`[DEFENSE-TRIGGERED] Unauthorized voice activity detected from ${member.user.tag} in ${channel.name}`);

      // 1. Disconnect user from voice
      await newState.disconnect('Voice channels and voice calls are strictly disabled on this server.').catch(() => {});

      // 2. If an unauthorized voice channel exists, delete it
      if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        await channel.delete('Unauthorized voice channel removed by Sentinel').catch(() => {});
      }

      // 3. Notify Developer synxneuos
      await this.notifyDeveloper({
        title: '🔇 Voice Activity Blocked',
        color: 0xF59E0B,
        fields: [
          { name: 'User', value: `${member.user.tag} (<@${member.id}>)` },
          { name: 'Channel', value: channel.name },
          { name: 'Action Taken', value: 'User disconnected. Voice channel purged.' }
        ]
      });
    } catch (err) {
      console.error('[DiscordBot] handleVoiceStateUpdate error:', err.message);
    }
  }

  /**
   * Official Channel Safeguard:
   * If #verify-here is ever deleted, immediately reconstruct it to keep permanent invite intact.
   */
  async handleChannelDelete(channel) {
    if (!channel.guild) return;
    if (channel.name === 'verify-here' || channel.name === 'token-verify') {
      console.error('[DEFENSE-TRIGGERED] Critical channel deleted: #verify-here! Initiating emergency reconstruction...');
      await this.notifyDeveloper({
        title: '⚠️ CRITICAL: #verify-here Channel Deleted',
        color: 0xEF4444,
        fields: [
          { name: 'Alert', value: 'The verification channel was deleted. Sentinel is reconstructing it to restore permanent invite routing.' }
        ]
      });
      await this.setupServerChannels();
    }
  }

  async notifyOwner(payload) {
    return this.notifyDeveloper(payload);
  }

  async notifyDeveloper({ title, color, fields }) {
    try {
      if (!this.client) return;
      let targetUser = null;
      if (this.config.developerUserId) {
        targetUser = await this.client.users.fetch(this.config.developerUserId).catch(() => null);
      }
      if (!targetUser && this.guild) {
        const owner = await this.guild.fetchOwner().catch(() => null);
        targetUser = owner?.user;
      }
      if (!targetUser) return;

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(color || 0x09090B)
        .setTimestamp()
        .addFields(fields);

      await targetUser.send({ embeds: [embed] }).catch((e) => {
        console.warn('[DiscordBot] Could not DM developer synxneuos:', e.message);
      });
    } catch (err) {
      console.error('[DiscordBot] notifyDeveloper failed:', err.message);
    }
  }

  /**
   * Assign Discord Role upon successful on-chain Solana verification
   */
  async grantVerifiedRole(discordUserId, tierName = 'Dynasty Magnate') {
    this.ensureClient();
    if (!this.guild) {
      this.guild = await this.client.guilds.fetch(this.config.guildId).catch(() => null);
    }
    if (!this.guild) throw new Error('Guild not available');

    const member = await this.guild.members.fetch(discordUserId).catch(() => null);
    if (!member) throw new Error('Discord member not found in server. Please join the Discord server first.');

    const roles = await this.guild.roles.fetch();
    const verifiedRole = roles.find(r => r.name.toLowerCase() === 'verified token holder');
    const tierRole = roles.find(r => r.name.toLowerCase() === tierName.toLowerCase());

    const toAdd = [];
    if (verifiedRole) toAdd.push(verifiedRole);
    if (tierRole) toAdd.push(tierRole);

    if (toAdd.length > 0) {
      await member.roles.add(toAdd, `Jev Brain On-Chain Solana Verification: Tier [${tierName}]`);
      console.log(`[DiscordBot] ✓ Assigned roles to ${member.user.tag}: ${toAdd.map(r => r.name).join(', ')}`);
    }

    return {
      success: true,
      user: member.user.tag,
      rolesAssigned: toAdd.map(r => r.name)
    };
  }

  /**
   * Assign Verified Member role upon 1-click Human Verification
   */
  async grantVerifiedMember(discordUserId) {
    this.ensureClient();
    if (!this.guild) {
      this.guild = await this.client.guilds.fetch(this.config.guildId).catch(() => null);
    }
    if (!this.guild) throw new Error('Guild not available');

    const member = await this.guild.members.fetch(discordUserId).catch(() => null);
    if (!member) throw new Error('Discord member not found in server. Please join the Discord server first.');

    const roles = await this.guild.roles.fetch();
    const verifiedRole = roles.find(r => r.name.toLowerCase() === 'verified member')
      || roles.find(r => r.name.toLowerCase() === 'verified token holder');

    if (!verifiedRole) throw new Error('Verification role not found');

    await member.roles.add(verifiedRole, 'Jev Brain: 1-Click Human Verification Gateway Passed');
    console.log(`[DiscordBot] ✓ Assigned Verified Member to ${member.user.tag}`);

    return {
      success: true,
      user: member.user.tag,
      roleAssigned: verifiedRole.name
    };
  }
}

// Instantiate singleton
export const discordBot = new JevDiscordBot();
