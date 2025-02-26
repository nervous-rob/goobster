const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('fs').promises;
const path = require('path');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('whatsnew')
        .setDescription('Shows a summary of recent changes from the changelog')
        .addIntegerOption(option => 
            option.setName('days')
                .setDescription('Number of days to look back (default: 7)')
                .setRequired(false))
        .addIntegerOption(option => 
            option.setName('limit')
                .setDescription('Maximum number of changes to show (default: 10)')
                .setRequired(false)),
                
    async execute(interaction) {
        await interaction.deferReply();
        
        try {
            const days = interaction.options.getInteger('days') || 7;
            const limit = interaction.options.getInteger('limit') || 10;
            
            // Read the changelog file
            const changelogPath = path.join(__dirname, '../../changelog.md');
            const changelogContent = await fs.readFile(changelogPath, 'utf8');
            
            // Parse the changelog content
            const changes = parseChangelog(changelogContent, days);
            
            if (changes.length === 0) {
                return await interaction.editReply('No changes found in the specified time period.');
            }
            
            // Limit the number of changes to display
            const limitedChanges = changes.slice(0, limit);
            
            // Create an embed to display the changes
            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`What's New (Recent Changes)`)
                .setDescription(`Here's a summary of the latest ${limitedChanges.length} changes:`)
                .setTimestamp();
            
            // Add each change as a field in the embed
            limitedChanges.forEach((change, index) => {
                embed.addFields({
                    name: `${index + 1}. ${change.date} - ${change.title}`,
                    value: change.description
                });
            });
            
            // Add footer with information about the command
            embed.setFooter({ 
                text: `Use /whatsnew days:<number> limit:<number> to customize this view` 
            });
            
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error executing whatsnew command:', error);
            await interaction.editReply('An error occurred while fetching the change history. Please try again later.');
        }
    },
};

/**
 * Parse the changelog content to extract changes
 * @param {string} content - The changelog content
 * @param {number} days - Number of days to look back
 * @returns {Array} Array of changes
 */
function parseChangelog(content, days) {
    const changes = [];
    const lines = content.split('\n');
    
    let currentDate = '';
    let currentSection = '';
    let currentTitle = '';
    let currentDescription = '';
    let isCollectingChanges = false;
    
    // Calculate the cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Check for date headers (## YYYY-MM-DD)
        const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
        if (dateMatch) {
            // Save previous section if we were collecting changes
            if (isCollectingChanges && currentTitle) {
                changes.push({
                    date: currentDate,
                    title: currentTitle,
                    description: currentDescription.trim()
                });
            }
            
            currentDate = dateMatch[1];
            currentTitle = '';
            currentDescription = '';
            
            // Check if this date is within the time range
            try {
                const entryDate = new Date(currentDate);
                isCollectingChanges = entryDate >= cutoffDate;
            } catch (e) {
                // If date parsing fails, include it anyway
                isCollectingChanges = true;
            }
            continue;
        }
        
        // Check for section headers (### Added, ### Changed, etc.)
        const sectionMatch = line.match(/^### (.*)$/);
        if (sectionMatch && isCollectingChanges) {
            // Save previous section if we were collecting changes
            if (currentTitle) {
                changes.push({
                    date: currentDate,
                    title: currentTitle,
                    description: currentDescription.trim()
                });
            }
            
            currentSection = sectionMatch[1];
            currentTitle = '';
            currentDescription = '';
            continue;
        }
        
        // Check for change items (- Added something)
        const changeMatch = line.match(/^- (.*)$/);
        if (changeMatch && isCollectingChanges && currentSection) {
            // Save previous item if we were collecting changes
            if (currentTitle) {
                changes.push({
                    date: currentDate,
                    title: currentTitle,
                    description: currentDescription.trim()
                });
            }
            
            currentTitle = `${currentSection}: ${changeMatch[1]}`;
            currentDescription = '';
            continue;
        }
        
        // Check for sub-items (  - Something specific)
        const subItemMatch = line.match(/^  - (.*)$/);
        if (subItemMatch && isCollectingChanges && currentTitle) {
            currentDescription += `• ${subItemMatch[1]}\n`;
            continue;
        }
    }
    
    // Add the last section if we were collecting changes
    if (isCollectingChanges && currentTitle) {
        changes.push({
            date: currentDate,
            title: currentTitle,
            description: currentDescription.trim() || 'No additional details'
        });
    }
    
    return changes;
} 