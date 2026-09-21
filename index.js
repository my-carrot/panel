import { 
  Client, 
  GatewayIntentBits, 
  SlashCommandBuilder, 
  REST, 
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags
} from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Configuration
const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  apiUrl: process.env.JINHUB_API_URL || 'https://jinhub.my.id',
  adminToken: process.env.ADMIN_TOKEN,
  cooldownHours: parseInt(process.env.RESET_COOLDOWN_HOURS) || 48,
  logChannelId: process.env.RESET_LOG_CHANNEL_ID || null,
  panelChannelId: process.env.PANEL_CHANNEL_ID || null, // NEW: Channel for permanent panel
  panelMessageId: process.env.PANEL_MESSAGE_ID || null  // NEW: Message ID to edit
};

// Cooldown storage (in production, use database)
const COOLDOWN_FILE = './cooldowns.json';
let cooldowns = {};

// Load cooldowns from file
function loadCooldowns() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      const data = fs.readFileSync(COOLDOWN_FILE, 'utf8');
      cooldowns = JSON.parse(data);
      console.log('[Cooldown] Loaded cooldowns:', Object.keys(cooldowns).length, 'users');
    }
  } catch (error) {
    console.error('[Cooldown] Error loading cooldowns:', error);
    cooldowns = {};
  }
}

// Helper function: Auto-delete ephemeral message after delay
async function replyWithAutoDelete(interaction, options, deleteAfterMs = 5 * 60 * 1000) {
  try {
    const message = await interaction.editReply(options);
    
    // Auto-delete after specified time (default 5 minutes)
    setTimeout(async () => {
      try {
        await message.delete();
        console.log(`[Bot] Auto-deleted message for user ${interaction.user.tag}`);
      } catch (error) {
        // Message might already be deleted or bot lacks permissions
        if (error.code !== 10008) { // Ignore "Unknown Message" error
          console.error('[Bot] Error deleting message:', error.message);
        }
      }
    }, deleteAfterMs);
    
    return message;
  } catch (error) {
    console.error('[Bot] Error sending reply:', error);
    throw error;
  }
}

// Save cooldowns to file
function saveCooldowns() {
  try {
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2));
    console.log('[Cooldown] Saved cooldowns');
  } catch (error) {
    console.error('[Cooldown] Error saving cooldowns:', error);
  }
}

// Check if user is on cooldown
function isOnCooldown(userId, key) {
  // Admin bypass - check if user has admin role or is owner
  const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '').split(',').filter(id => id.trim()).map(id => id.trim());
  if (ADMIN_USER_IDS.length > 0 && ADMIN_USER_IDS.includes(userId)) {
    console.log(`[Cooldown] Admin bypass for user ${userId}`);
    return { onCooldown: false };
  }
  
  const cooldownKey = `${userId}:${key}`;
  
  if (!cooldowns[cooldownKey]) {
    return { onCooldown: false };
  }

  const lastReset = new Date(cooldowns[cooldownKey]);
  const now = new Date();
  const cooldownMs = CONFIG.cooldownHours * 60 * 60 * 1000; // Convert hours to ms
  const timeSinceReset = now - lastReset;
  
  if (timeSinceReset < cooldownMs) {
    const timeRemaining = cooldownMs - timeSinceReset;
    const hoursRemaining = Math.floor(timeRemaining / (1000 * 60 * 60));
    const minutesRemaining = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
    
    return {
      onCooldown: true,
      hoursRemaining,
      minutesRemaining,
      nextResetDate: new Date(lastReset.getTime() + cooldownMs)
    };
  }

  return { onCooldown: false };
}

// Set cooldown for user
function setCooldown(userId, key) {
  const cooldownKey = `${userId}:${key}`;
  cooldowns[cooldownKey] = new Date().toISOString();
  saveCooldowns();
}

// Get user's cooldown info
function getUserCooldownInfo(userId) {
  const userCooldowns = Object.keys(cooldowns)
    .filter(key => key.startsWith(`${userId}:`))
    .map(key => {
      const keyName = key.split(':')[1];
      const lastReset = new Date(cooldowns[key]);
      const cooldownCheck = isOnCooldown(userId, keyName);
      
      return {
        key: keyName,
        lastReset: lastReset,
        canReset: !cooldownCheck.onCooldown,
        nextReset: cooldownCheck.nextResetDate
      };
    });
  
  return userCooldowns;
}

// Reset HWID via API
async function resetHWIDAPI(key) {
  try {
    const response = await fetch(`${CONFIG.apiUrl}/api/premium/reset-hwid`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'JinHub-Discord-Bot/1.0'
      },
      body: JSON.stringify({
        key: key,
        adminToken: CONFIG.adminToken
      })
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[API] Error resetting HWID:', error);
    return { success: false, error: error.message };
  }
}

// Verify key exists via API (for HWID reset - allows expired keys)
async function verifyKeyAPI(key) {
  try {
    const response = await fetch(`${CONFIG.apiUrl}/api/premium/verify?key=${encodeURIComponent(key)}`, {
      headers: {
        'User-Agent': 'JinHub-Discord-Bot/1.0'
      }
    });
    const data = await response.json();
    
    // For HWID reset, we allow expired keys
    // Only reject if key doesn't exist or is revoked
    if (!data.success && data.error === 'Key not found') {
      return { valid: false, error: 'Key not found' };
    }
    
    if (data.error === 'Key revoked' || data.status === 'revoked') {
      return { valid: false, error: 'Key revoked' };
    }
    
    // Accept both valid and expired keys
    return {
      valid: true,
      ...data,
      isExpired: data.error === 'Key expired' || data.status === 'expired'
    };
  } catch (error) {
    console.error('[API] Error verifying key:', error);
    return { valid: false, error: error.message };
  }
}

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

// Commands
const commands = [
  new SlashCommandBuilder()
    .setName('setup-panel')
    .setDescription('Setup permanent HWID reset panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  
  new SlashCommandBuilder()
    .setName('check-cooldown')
    .setDescription('Check your HWID reset cooldown status')
    .addStringOption(option =>
      option
        .setName('key')
        .setDescription('Your premium key (optional - shows all if not specified)')
        .setRequired(false)
    ),
  
  new SlashCommandBuilder()
    .setName('my-resets')
    .setDescription('View all your HWID reset history and cooldowns')
];

// Register commands
async function registerCommands() {
  try {
    console.log('[Commands] Registering slash commands...');
    
    const rest = new REST({ version: '10' }).setToken(CONFIG.discordToken);
    
    await rest.put(
      Routes.applicationCommands(CONFIG.clientId),
      { body: commands.map(cmd => cmd.toJSON()) }
    );
    
    console.log('[Commands] Successfully registered slash commands!');
  } catch (error) {
    console.error('[Commands] Error registering commands:', error);
  }
}

// Bot ready event
client.once('ready', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  console.log(`[Bot] Serving ${client.guilds.cache.size} servers`);
  console.log(`[Config] API URL: ${CONFIG.apiUrl}`);
  console.log(`[Config] Reset Cooldown: ${CONFIG.cooldownHours} hours (${CONFIG.cooldownHours / 24} days)`);
  
  // Set bot status
  client.user.setActivity('JinHub HWID Reset', { type: 'WATCHING' });
  
  // Setup panel if configured
  if (CONFIG.panelChannelId) {
    setupPermanentPanel();
  }
});

// Setup permanent panel in channel
async function setupPermanentPanel() {
  try {
    const channel = await client.channels.fetch(CONFIG.panelChannelId);
    if (!channel) {
      console.error('[Panel] Channel not found:', CONFIG.panelChannelId);
      return;
    }

    const payload = buildPanelCard();

    if (CONFIG.panelMessageId) {
      // Update existing message
      try {
        const message = await channel.messages.fetch(CONFIG.panelMessageId);
        await message.edit(payload);
        console.log('[Panel] Updated existing panel message');
      } catch (error) {
        console.error('[Panel] Could not update message, creating new one:', error);
        const newMessage = await channel.send(payload);
        console.log('[Panel] Created new panel message:', newMessage.id);
        console.log('[Panel] Add this to .env: PANEL_MESSAGE_ID=' + newMessage.id);
      }
    } else {
      // Create new message
      const newMessage = await channel.send(payload);
      console.log('[Panel] Created new panel message:', newMessage.id);
      console.log('[Panel] Add this to .env: PANEL_MESSAGE_ID=' + newMessage.id);
    }
  } catch (error) {
    console.error('[Panel] Error setting up panel:', error);
  }
}

// Purchase access link (shown via the "Open Pricing" link button)
const PURCHASE_URL = 'https://discordapp.com/channels/1409740790141423738/1443912803881586731';

// Build the panel buttons (all green / Success style, no emoji)
function createPanelButtons() {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('purchase_key')
        .setLabel('Purchase')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('reset_hwid_modal')
        .setLabel('Reset HWID')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('check_cooldown_list')
        .setLabel('Check Cooldown')
        .setStyle(ButtonStyle.Success)
    );
}

// Build the panel card using Components V2 (no embed, no left accent bar,
// buttons live inside the same box as the title/description)
function buildPanelCard() {
  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## JinHub - Panel'))
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '**Manage Your Freemium/Premium key From Panel**\n\n' +
        '**Purchase** buy license key • **Reset HWID**\nReset hardware ID your device • **Check Cooldown** Time until your next reset'
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    )
    .addActionRowComponents(createPanelButtons());

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

// Build the "HWID Reset Successful" card using Components V2 (no embed, no left accent bar)
function buildResetSuccessCard({ key, tierName, nextResetDate }) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## <:check1:1551389827159556177> HWID Reset Successful!'),
    new TextDisplayBuilder().setContent('Your hardware ID has been reset successfully.'),
    new TextDisplayBuilder().setContent(`**Key**\n\`${key}\``),
    new TextDisplayBuilder().setContent(`**Tier**\n${tierName}`),
    new TextDisplayBuilder().setContent(
      `<a:timesand:1551390654804795392> **Next Reset Available**\n<t:${Math.floor(nextResetDate.getTime() / 1000)}:R>`
    ),
    new TextDisplayBuilder().setContent(
      `-# JinHub System • You can now bind this key to a new device`
    )
  );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

// Build the "Your Cooldown Status" card using Components V2 (no embed, no left accent bar)
function buildCooldownStatusCard(userCooldowns) {
  const lines = [];

  lines.push('## <a:timesand:1551390654804795392> Your Cooldown Status');

  if (userCooldowns.length === 0) {
    lines.push('You haven\'t reset any keys yet.\n\nUse the "Reset HWID" button to reset a key.');
  } else {
    lines.push(`Total keys reset: **${userCooldowns.length}**`);

    for (const cd of userCooldowns) {
      const status = cd.canReset ? 'Ready' : `<t:${Math.floor(cd.nextReset.getTime() / 1000)}:R>`;
      lines.push(`**${cd.key}**\nLast: <t:${Math.floor(cd.lastReset.getTime() / 1000)}:R>\n${status}`);
    }
  }

  lines.push('-# JinHub System • Cooldown: 2 days');

  const container = new ContainerBuilder().addTextDisplayComponents(
    ...lines.map((c) => new TextDisplayBuilder().setContent(c))
  );

  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [container],
  };
}

// Generic helper: build a plain Components V2 card from an array of text blocks.
// Each entry becomes its own TextDisplay component (rendered stacked, no embed, no accent bar).
function buildCard(lines) {
  const container = new ContainerBuilder().addTextDisplayComponents(
    ...lines.map((c) => new TextDisplayBuilder().setContent(c))
  );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
  };
}

// Handle slash commands and interactions
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;

  const { user } = interaction;

  // Handle modal submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'reset_hwid_modal_form') {
      await interaction.deferReply({ ephemeral: true });

      const keyInput = interaction.fields.getTextInputValue('key_input').trim();
      
      // Preserve case for free keys (JinHub-xxx-xxx-xxx)
      // Only uppercase for premium keys (JH[FSLP]-XXX-XXX-XXX)
      const key = keyInput.startsWith('JinHub-') || keyInput.startsWith('jinhub-') 
        ? keyInput.replace(/^jinhub-/i, 'JinHub-') // Normalize to JinHub- prefix
        : keyInput.toUpperCase(); // Premium keys to uppercase
      
      // Validate key format (support both FREE and PREMIUM formats)
      const premiumFormat = /^JH[FSLP]-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
      const freeFormat = /^JinHub-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/;
      
      if (!premiumFormat.test(key) && !freeFormat.test(key)) {
        return await replyWithAutoDelete(interaction, buildCard([
          '## ❌ Invalid Key Format',
          'Please provide a valid JinHub key format.',
          '**Valid Premium Format**\n`XXX-XXXX-XXXX-XXXX`',
          '**Valid Free Format**\n`JinHub-XXXXXX-XXXXXX-XXXXXX`',
          '-# JinHub System',
        ]));
      }

      // Check cooldown
      const cooldownCheck = isOnCooldown(user.id, key);
      if (cooldownCheck.onCooldown) {
        return await replyWithAutoDelete(interaction, buildCard([
          '## ⏰ Reset on Cooldown',
          'You need to wait before resetting this key again.',
          `**Time Remaining**\n${cooldownCheck.hoursRemaining}h ${cooldownCheck.minutesRemaining}m`,
          `**Next Reset Available**\n<t:${Math.floor(cooldownCheck.nextResetDate.getTime() / 1000)}:R>`,
          '-# JinHub System • Cooldown: 2 days',
        ]));
      }

      // Verify key
      console.log(`[Reset] User ${user.tag} (${user.id}) attempting to reset key: ${key}`);
      
      // Determine if it's a free or premium key based on format
      const isFreeKey = key.startsWith('JinHub-'); // Case-sensitive for free keys
      const isPremiumKey = /^JH[FSLP]-/.test(key);
      
      let verifyResult;
      let keyData;
      
      if (isFreeKey) {
        // For free keys, try to find via keymap first, then fallback to find-key search
        try {
          const findResponse = await fetch(`${CONFIG.apiUrl}/api/kv-editor`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${CONFIG.adminToken}`
            },
            body: JSON.stringify({
              action: 'find-key',
              keyString: key,
              token: CONFIG.adminToken
            })
          });
          
          const findData = await findResponse.json();
          
          if (findData.success && findData.found) {
            // Key found!
            keyData = {
              key: key,
              provider: findData.provider,
              jhId: findData.jhId,
              keyObj: findData.keyObj,
              recordKey: findData.recordKey,
              record: findData.record
            };
            
            verifyResult = { 
              valid: true, 
              keyType: 'free',
              provider: findData.provider,
              expiresAt: findData.keyObj.expiresAt ? new Date(findData.keyObj.expiresAt).toISOString() : null,
              hwid: findData.keyObj.hwid || null,
              isExpired: findData.keyObj.expiresAt && findData.keyObj.expiresAt <= Date.now()
            };
          } else {
            verifyResult = { 
              valid: false, 
              error: findData.error || 'Key not found. If expired, try renewing from browser first.' 
            };
          }
        } catch (error) {
          console.error(`[Reset] Error finding free key:`, error);
          verifyResult = { valid: false, error: error.message };
        }
      } else {
        // Premium key - use normal verify API
        verifyResult = await verifyKeyAPI(key);
      }
      
      if (!verifyResult || !verifyResult.valid) {
        return await replyWithAutoDelete(interaction, buildCard([
          '## ❌ Invalid Key',
          'This key does not exist or is invalid.',
          `**Error**\n${verifyResult?.error || 'Key not found in database'}`,
          '-# JinHub System',
        ]));
      }

      // Reset HWID
      let resetResult;
      
      if (isFreeKey && keyData) {
        // Reset free key HWID by updating the key object
        try {
          // Log old HWID BEFORE clearing it
          const oldHwid = keyData.keyObj.hwid;
          console.log(`[Reset] Resetting FREE key HWID in KV: ${keyData.recordKey}`);
          console.log(`[Reset] Old HWID: ${oldHwid}`);
          console.log(`[Reset] Old boundAt: ${keyData.keyObj.boundAt}`);
          
          // Find the key in the record array and update it directly
          const keyIndex = keyData.record.keys.findIndex(k => k.key === key);
          
          if (keyIndex === -1) {
            console.error('[Reset] Key not found in record.keys array!');
            throw new Error('Key not found in record');
          }
          
          console.log(`[Reset] Found key at index ${keyIndex}`);
          
          // Update directly in the record array
          keyData.record.keys[keyIndex].hwid = null;
          keyData.record.keys[keyIndex].boundAt = null;
          keyData.record.keys[keyIndex].lastReset = new Date().toISOString();
          keyData.record.keys[keyIndex].resetCount = (keyData.record.keys[keyIndex].resetCount || 0) + 1;
          
          console.log(`[Reset] New HWID value: ${keyData.record.keys[keyIndex].hwid}`);
          console.log(`[Reset] Reset count: ${keyData.record.keys[keyIndex].resetCount}`);
          
          // Update the record in KV
          const updateResponse = await fetch(`${CONFIG.apiUrl}/api/kv-editor`, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${CONFIG.adminToken}`
            },
            body: JSON.stringify({
              action: 'set',
              key: keyData.recordKey,
              value: keyData.record, // Send object directly, kv-editor will stringify it
              token: CONFIG.adminToken
            })
          });
          
          const updateData = await updateResponse.json();
          
          console.log(`[Reset] FREE key update result:`, updateData);
          
          if (updateData.success) {
            // IMPORTANT: Invalidate keymap cache by deleting and recreating it
            // This forces Cloudflare to fetch fresh keyrec data
            console.log(`[Reset] Invalidating keymap cache for ${key}...`);
            
            const keymapKey = `keymap:${keyData.provider}:${key}`;
            
            // Delete keymap
            const deleteResponse = await fetch(`${CONFIG.apiUrl}/api/kv-editor`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.adminToken}`
              },
              body: JSON.stringify({
                action: 'delete',
                key: keymapKey,
                token: CONFIG.adminToken
              })
            });
            
            const deleteResult = await deleteResponse.json();
            console.log(`[Reset] Deleted keymap: ${keymapKey}`, deleteResult);
            
            if (!deleteResult.success) {
              console.error('[Reset] ❌ Failed to delete keymap:', deleteResult.error);
              throw new Error(`Failed to delete keymap: ${deleteResult.error}`);
            }
            
            // Recreate keymap with TTL based on key expiration
            const now = Date.now();
            const expiresAt = keyData.record.keys[keyIndex].expiresAt;
            const ttlSeconds = expiresAt > now ? Math.ceil((expiresAt - now) / 1000 * 1.5) : 3600;
            
            const recreateResponse = await fetch(`${CONFIG.apiUrl}/api/kv-editor`, {
              method: 'POST',
              headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CONFIG.adminToken}`
              },
              body: JSON.stringify({
                action: 'set',
                key: keymapKey,
                value: keyData.jhId,
                ttl: ttlSeconds, // Add TTL support
                token: CONFIG.adminToken
              })
            });
            
            const recreateResult = await recreateResponse.json();
            console.log(`[Reset] Recreated keymap with TTL ${ttlSeconds}s`, recreateResult);
            
            if (!recreateResult.success) {
              console.error('[Reset] ❌ Failed to recreate keymap:', recreateResult.error);
              throw new Error(`Failed to recreate keymap: ${recreateResult.error}`);
            }
            
            resetResult = {
              success: true,
              message: 'HWID reset successfully',
              key: key,
              resetCount: keyData.record.keys[keyIndex].resetCount,
              tier: 'free',
              tierName: 'Free',
              provider: keyData.provider
            };
            
            console.log(`[Reset] ✅ FREE key HWID reset successful: ${key}`);
          } else {
            resetResult = {
              success: false,
              error: updateData.error || 'Failed to update KV'
            };
            
            console.error(`[Reset] ❌ FREE key HWID reset failed:`, updateData.error);
          }
        } catch (error) {
          console.error('[Reset] Error resetting free key HWID:', error);
          resetResult = {
            success: false,
            error: error.message || 'Unknown error'
          };
        }
      } else {
        // Premium key - use normal reset API
        console.log(`[Reset] Resetting PREMIUM key HWID via API: ${key}`);
        resetResult = await resetHWIDAPI(key);
        console.log(`[Reset] PREMIUM key reset result:`, resetResult);
        
        if (resetResult.success) {
          console.log(`[Reset] ✅ PREMIUM key HWID reset successful: ${key}`);
        } else {
          console.error(`[Reset] ❌ PREMIUM key HWID reset failed:`, resetResult.error);
        }
      }
      
      if (!resetResult.success) {
        return await replyWithAutoDelete(interaction, buildCard([
          '## ❌ Reset Failed',
          'Failed to reset HWID. Please try again or contact support.',
          `**Error**\n${resetResult.error || 'Unknown error'}`,
          '-# JinHub System',
        ]));
      }

      // Success! Set cooldown
      setCooldown(user.id, key);
      
      const nextResetDate = new Date(Date.now() + (CONFIG.cooldownHours * 60 * 60 * 1000));
      
      const successPayload = buildResetSuccessCard({
        key,
        tierName: verifyResult.tierName || verifyResult.tier,
        nextResetDate
      });
      
      await replyWithAutoDelete(interaction, successPayload);

      // Log to channel if configured
      if (CONFIG.logChannelId) {
        try {
          const logChannel = await client.channels.fetch(CONFIG.logChannelId);
          if (logChannel) {
            await logChannel.send(buildCard([
              '## 🔄 HWID Reset Log',
              `**User**\n${user.tag} (${user.id})`,
              `**Key**\n\`${key}\``,
              `**Tier**\n${verifyResult.tierName || verifyResult.tier}`,
            ]));
          }
        } catch (error) {
          console.error('[Log] Error sending to log channel:', error);
        }
      }

      console.log(`[Reset] Success! User ${user.tag} reset key ${key}`);
      return;
    }
    
    return;
  }

  // Handle button interactions
  if (interaction.isButton()) {
    // Purchase button -> show a link button to the pricing page
    if (interaction.customId === 'purchase_key') {
      const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Open Ticket')
          .setStyle(ButtonStyle.Link)
          .setURL(PURCHASE_URL)
      );

      return await interaction.reply({
        content: 'Open the JinHub pricing page to purchase access.',
        components: [linkRow],
        ephemeral: true
      });
    }
    
    // Reset HWID button - show modal
    if (interaction.customId === 'reset_hwid_modal') {
      const modal = new ModalBuilder()
        .setCustomId('reset_hwid_modal_form')
        .setTitle('Reset HWID');

      const keyInput = new TextInputBuilder()
        .setCustomId('key_input')
        .setLabel('Enter script key below:')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('XXXX-XXXX-XXXX-XXXX')
        .setRequired(true)
        .setMinLength(16)
        .setMaxLength(30);

      const firstRow = new ActionRowBuilder().addComponents(keyInput);
      modal.addComponents(firstRow);

      return await interaction.showModal(modal);
    }
    
    // Check Cooldown button
    if (interaction.customId === 'check_cooldown_list') {
      const userCooldowns = getUserCooldownInfo(user.id);
      return await interaction.reply(buildCooldownStatusCard(userCooldowns));
    }
    
    return;
  }

  const { commandName } = interaction;

  // /setup-panel command (Admin only)
  if (commandName === 'setup-panel') {
    await interaction.deferReply({ ephemeral: true });

    const payload = buildPanelCard();

    try {
      const message = await interaction.channel.send(payload);
      
      await interaction.editReply(buildCard([
        '## ✅ Panel Setup Complete',
        'Permanent panel has been created in this channel.\n\n' +
        '**Important:** Add these to your `.env` file:\n' +
        '```env\n' +
        `PANEL_CHANNEL_ID=${interaction.channel.id}\n` +
        `PANEL_MESSAGE_ID=${message.id}\n` +
        '```\n' +
        'Then restart the bot to enable auto-update on restart.',
        '-# JinHub System',
      ]));
      
      console.log('[Panel] Setup complete - Channel:', interaction.channel.id, 'Message:', message.id);
    } catch (error) {
      await interaction.editReply(buildCard([
        '## ❌ Setup Failed',
        'Failed to create panel. Make sure bot has permission to send messages.',
        `**Error**\n${error.message}`,
      ]));
    }
    
    return;
  }

  // /check-cooldown command
  else if (commandName === 'check-cooldown') {
    await interaction.deferReply({ ephemeral: true });

    const key = interaction.options.getString('key');
    
    if (key) {
      const cleanKey = key.toUpperCase().trim();
      const cooldownCheck = isOnCooldown(user.id, cleanKey);
      
      const lines = ['## ⏰ Cooldown Status', `**Key**\n\`${cleanKey}\``];
      
      if (cooldownCheck.onCooldown) {
        lines.push('❌ This key is on cooldown');
        lines.push(`**Time Remaining**\n${cooldownCheck.hoursRemaining}h ${cooldownCheck.minutesRemaining}m`);
        lines.push(`**Next Reset**\n<t:${Math.floor(cooldownCheck.nextResetDate.getTime() / 1000)}:R>`);
      } else {
        lines.push('✅ This key can be reset now!');
      }
      
      return await interaction.editReply(buildCard(lines));
    } else {
      // Show all user's cooldowns
      const userCooldowns = getUserCooldownInfo(user.id);
      
      if (userCooldowns.length === 0) {
        return await interaction.editReply(buildCard([
          '## 📋 Your Reset History',
          'You haven\'t reset any keys yet.',
        ]));
      }
      
      const lines = ['## 📋 Your Reset History', `Total keys reset: **${userCooldowns.length}**`];
      
      userCooldowns.forEach(cd => {
        const status = cd.canReset ? 'Can reset' : `<t:${Math.floor(cd.nextReset.getTime() / 1000)}:R>`;
        lines.push(`**${cd.key}**\nLast reset: <t:${Math.floor(cd.lastReset.getTime() / 1000)}:R>\n${status}`);
      });
      
      return await interaction.editReply(buildCard(lines));
    }
  }

  // /my-resets command
  else if (commandName === 'my-resets') {
    await interaction.deferReply({ ephemeral: true });

    const userCooldowns = getUserCooldownInfo(user.id);
    
    if (userCooldowns.length === 0) {
      return await interaction.editReply(buildCard([
        '## 📋 Your Reset History',
        'You haven\'t reset any keys yet.\n\nUse `/reset-hwid` to reset a key\'s HWID.',
        `**How it works**\n• Each key can be reset once every **${CONFIG.cooldownHours / 24} days**\n• Cooldown applies to all tiers (Free & Premium)\n• After reset, you can bind the key to a new device`,
      ]));
    }

    const lines = ['## 📋 Your HWID Reset History', `You have reset **${userCooldowns.length}** key(s)`];
    
    userCooldowns.forEach((cd, index) => {
      const status = cd.canReset 
        ? '**Ready to reset**' 
        : `Next reset: <t:${Math.floor(cd.nextReset.getTime() / 1000)}:R>`;
      
      const lastResetText = `<t:${Math.floor(cd.lastReset.getTime() / 1000)}:F>`;
      
      lines.push(`**${index + 1}. ${cd.key}**\nLast reset: ${lastResetText}\n${status}`);
    });
    
    lines.push(`-# Cooldown period: ${CONFIG.cooldownHours / 24} days`);
    
    return await interaction.editReply(buildCard(lines));
  }
});

// Error handling
client.on('error', error => {
  console.error('[Bot] Error:', error);
});

process.on('unhandledRejection', error => {
  console.error('[Process] Unhandled rejection:', error);
});

// Start bot
async function start() {
  console.log('[Bot] Starting JinHub Discord Bot...');
  
  // Validate configuration
  if (!CONFIG.discordToken) {
    console.error('[Config] Error: DISCORD_TOKEN is not set in .env file');
    process.exit(1);
  }
  
  if (!CONFIG.clientId) {
    console.error('[Config] Error: DISCORD_CLIENT_ID is not set in .env file');
    process.exit(1);
  }
  
  if (!CONFIG.adminToken) {
    console.error('[Config] Error: ADMIN_TOKEN is not set in .env file');
    process.exit(1);
  }

  // Load cooldowns
  loadCooldowns();

  // Register commands
  await registerCommands();

  // Login to Discord
  await client.login(CONFIG.discordToken);
}

start();
