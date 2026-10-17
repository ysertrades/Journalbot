'use strict';
const { ContainerBuilder, MessageFlags, TextDisplayBuilder } = require('discord.js');
const { NEUTRAL_COLOR } = require('./format');

const EPH = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
const card = (text, color = NEUTRAL_COLOR) => new ContainerBuilder().setAccentColor(color).addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
const ephemeral = (...containers) => ({ components: containers, flags: EPH });
const v2 = (...containers) => ({ components: containers, flags: MessageFlags.IsComponentsV2 });
module.exports = { card, ephemeral, v2, EPH };
