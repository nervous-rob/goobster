#!/usr/bin/env node

/**
 * Rebuild Changelog Script
 * 
 * This script rebuilds the changelog.md file from git history.
 * It categorizes commits based on conventional commit messages
 * and organizes them by date.
 * 
 * Usage: node scripts/rebuild-changelog.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
  changelogPath: path.join(__dirname, '../changelog.md'),
  repoName: 'goobster',
  defaultTitle: 'Goobster Bot',
  includeUnreleased: true,
  maxCommitsToProcess: 500, // Limit to prevent processing entire history
  groupByDate: true, // Group commits by date instead of by version tags
};

// Categories for conventional commits
const categories = {
  feat: 'Added',
  feature: 'Added',
  add: 'Added',
  fix: 'Fixed',
  bugfix: 'Fixed',
  perf: 'Performance',
  performance: 'Performance',
  refactor: 'Changed',
  style: 'Changed',
  docs: 'Documentation',
  doc: 'Documentation',
  test: 'Testing',
  chore: 'Maintenance',
  build: 'Build',
  ci: 'CI/CD',
  security: 'Security',
};

// Get all tags sorted by date (newest first)
function getTags() {
  try {
    const tagsOutput = execSync('git tag --sort=-creatordate').toString().trim();
    return tagsOutput ? tagsOutput.split('\n') : [];
  } catch (error) {
    console.error('Error getting tags:', error.message);
    return [];
  }
}

// Get the date of a tag
function getTagDate(tag) {
  try {
    return execSync(`git log -1 --format=%ad --date=short ${tag}`).toString().trim();
  } catch (error) {
    console.error(`Error getting date for tag ${tag}:`, error.message);
    return 'Unknown Date';
  }
}

// Get all commits
function getAllCommits() {
  try {
    const format = '%H|%s|%an|%ad|%b';
    const command = `git log --format="${format}" --date=short -n ${config.maxCommitsToProcess}`;
    const output = execSync(command).toString().trim();
    
    if (!output) return [];
    
    return output.split('\n').map(line => {
      try {
        const parts = line.split('|');
        if (parts.length < 4) {
          console.warn('Warning: Invalid git log line format:', line);
          return null;
        }
        
        const [hash, subject, author, date, ...bodyParts] = parts;
        const body = bodyParts.join('|'); // Rejoin body parts in case they contained |
        return { hash, subject, author, date, body };
      } catch (error) {
        console.warn('Error parsing git log line:', error.message);
        return null;
      }
    }).filter(commit => commit !== null); // Filter out null entries
  } catch (error) {
    console.error(`Error getting commits:`, error.message);
    return [];
  }
}

// Get commits between two references
function getCommitsBetween(from, to) {
  const range = from ? `${from}..${to}` : to;
  try {
    const format = '%H|%s|%an|%ad|%b';
    const command = `git log --format="${format}" --date=short ${range} -n ${config.maxCommitsToProcess}`;
    const output = execSync(command).toString().trim();
    
    if (!output) return [];
    
    return output.split('\n').map(line => {
      try {
        const parts = line.split('|');
        if (parts.length < 4) {
          console.warn('Warning: Invalid git log line format:', line);
          return null;
        }
        
        const [hash, subject, author, date, ...bodyParts] = parts;
        const body = bodyParts.join('|'); // Rejoin body parts in case they contained |
        return { hash, subject, author, date, body };
      } catch (error) {
        console.warn('Error parsing git log line:', error.message);
        return null;
      }
    }).filter(commit => commit !== null); // Filter out null entries
  } catch (error) {
    console.error(`Error getting commits between ${from} and ${to}:`, error.message);
    return [];
  }
}

// Categorize a commit based on its message
function categorizeCommit(commit) {
  // Check if commit or subject is undefined
  if (!commit || !commit.subject) {
    console.warn('Warning: Invalid commit object received:', commit);
    return {
      hash: 'unknown',
      subject: 'Unknown commit',
      author: 'unknown',
      date: 'unknown',
      body: '',
      type: null,
      scope: null,
      message: 'Unknown commit',
      category: 'Other'
    };
  }

  // Parse conventional commit format: type(scope): message
  const match = commit.subject.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
  
  if (match) {
    const [, type, scope, message] = match;
    const category = categories[type.toLowerCase()] || 'Other';
    return {
      ...commit,
      type,
      scope,
      message,
      category,
    };
  }
  
  // Handle non-conventional commits
  // Try to guess category from keywords
  let category = 'Other';
  const subject = commit.subject.toLowerCase();
  
  if (subject.includes('fix') || subject.includes('resolv') || subject.includes('bug')) {
    category = 'Fixed';
  } else if (subject.includes('add') || subject.includes('new') || subject.includes('feat')) {
    category = 'Added';
  } else if (subject.includes('chang') || subject.includes('updat') || subject.includes('modif')) {
    category = 'Changed';
  } else if (subject.includes('remov') || subject.includes('delet')) {
    category = 'Removed';
  } else if (subject.includes('doc')) {
    category = 'Documentation';
  } else if (subject.includes('test')) {
    category = 'Testing';
  } else if (subject.includes('secur')) {
    category = 'Security';
  }
  
  return {
    ...commit,
    type: null,
    scope: null,
    message: commit.subject,
    category,
  };
}

// Group commits by category
function groupCommitsByCategory(commits) {
  const categorized = {};
  
  if (!Array.isArray(commits)) {
    console.warn('Warning: commits is not an array:', commits);
    return {};
  }
  
  commits.forEach(commit => {
    if (!commit) {
      console.warn('Warning: Undefined commit in array');
      return;
    }
    
    const categorizedCommit = categorizeCommit(commit);
    if (!categorizedCommit.category) {
      categorizedCommit.category = 'Other';
    }
    
    if (!categorized[categorizedCommit.category]) {
      categorized[categorizedCommit.category] = [];
    }
    categorized[categorizedCommit.category].push(categorizedCommit);
  });
  
  return categorized;
}

// Group commits by date
function groupCommitsByDate(commits) {
  const grouped = {};
  
  if (!Array.isArray(commits)) {
    console.warn('Warning: commits is not an array:', commits);
    return {};
  }
  
  commits.forEach(commit => {
    if (!commit) {
      console.warn('Warning: Undefined commit in array');
      return;
    }
    
    const categorizedCommit = categorizeCommit(commit);
    const date = categorizedCommit.date || 'Unknown Date';
    
    if (!grouped[date]) {
      grouped[date] = {};
    }
    
    const category = categorizedCommit.category || 'Other';
    if (!grouped[date][category]) {
      grouped[date][category] = [];
    }
    
    grouped[date][category].push(categorizedCommit);
  });
  
  return grouped;
}

// Generate changelog content
function generateChangelog() {
  let changelog = `# Changelog\n\n`;
  
  // Get current branch
  const currentBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  
  if (config.groupByDate) {
    // Get all commits
    const allCommits = getAllCommits();
    
    // Group commits by date
    const commitsByDate = groupCommitsByDate(allCommits);
    
    // Sort dates in descending order (newest first)
    const sortedDates = Object.keys(commitsByDate).sort().reverse();
    
    // Process each date
    sortedDates.forEach(date => {
      changelog += `## ${date}\n\n`;
      
      const categorizedCommits = commitsByDate[date];
      
      // Add each category
      Object.keys(categorizedCommits).sort().forEach(category => {
        changelog += `### ${category}\n`;
        
        // Group by scope if available
        const scopeGroups = {};
        categorizedCommits[category].forEach(commit => {
          const scope = commit.scope || 'General';
          if (!scopeGroups[scope]) {
            scopeGroups[scope] = [];
          }
          scopeGroups[scope].push(commit);
        });
        
        // Add commits by scope
        Object.keys(scopeGroups).sort().forEach(scope => {
          if (scope !== 'General') {
            changelog += `- ${scope}\n`;
            scopeGroups[scope].forEach(commit => {
              changelog += `  - ${commit.message}\n`;
            });
          } else {
            scopeGroups[scope].forEach(commit => {
              changelog += `- ${commit.message}\n`;
            });
          }
        });
        
        changelog += '\n';
      });
    });
  } else {
    // Original implementation - group by version tags
    const tags = getTags();
    
    // Add unreleased section if configured
    if (config.includeUnreleased) {
      const unreleasedCommits = getCommitsBetween(tags[0] || '', currentBranch);
      if (unreleasedCommits.length > 0) {
        changelog += `## [Unreleased]\n\n`;
        
        const categorizedCommits = groupCommitsByCategory(unreleasedCommits);
        
        // Add each category
        Object.keys(categorizedCommits).sort().forEach(category => {
          changelog += `### ${category}\n`;
          
          // Group by scope if available
          const scopeGroups = {};
          categorizedCommits[category].forEach(commit => {
            const scope = commit.scope || 'General';
            if (!scopeGroups[scope]) {
              scopeGroups[scope] = [];
            }
            scopeGroups[scope].push(commit);
          });
          
          // Add commits by scope
          Object.keys(scopeGroups).sort().forEach(scope => {
            if (scope !== 'General') {
              changelog += `- ${scope}\n`;
              scopeGroups[scope].forEach(commit => {
                changelog += `  - ${commit.message}\n`;
              });
            } else {
              scopeGroups[scope].forEach(commit => {
                changelog += `- ${commit.message}\n`;
              });
            }
          });
          
          changelog += '\n';
        });
      }
    }
    
    // Process each tag
    let previousTag = null;
    
    tags.forEach(tag => {
      const date = getTagDate(tag);
      changelog += `## [${tag}] - ${date}\n\n`;
      
      const commits = getCommitsBetween(previousTag, tag);
      const categorizedCommits = groupCommitsByCategory(commits);
      
      // Add each category
      Object.keys(categorizedCommits).sort().forEach(category => {
        changelog += `### ${category}\n`;
        
        // Group by scope if available
        const scopeGroups = {};
        categorizedCommits[category].forEach(commit => {
          const scope = commit.scope || 'General';
          if (!scopeGroups[scope]) {
            scopeGroups[scope] = [];
          }
          scopeGroups[scope].push(commit);
        });
        
        // Add commits by scope
        Object.keys(scopeGroups).sort().forEach(scope => {
          if (scope !== 'General') {
            changelog += `- ${scope}\n`;
            scopeGroups[scope].forEach(commit => {
              changelog += `  - ${commit.message}\n`;
            });
          } else {
            scopeGroups[scope].forEach(commit => {
              changelog += `- ${commit.message}\n`;
            });
          }
        });
        
        changelog += '\n';
      });
      
      previousTag = tag;
    });
    
    // Add initial version if no tags exist
    if (tags.length === 0) {
      const allCommits = getCommitsBetween(null, currentBranch);
      if (allCommits.length > 0) {
        changelog += `## [1.0.0] - Initial Release\n\n`;
        
        const categorizedCommits = groupCommitsByCategory(allCommits);
        
        // Add each category
        Object.keys(categorizedCommits).sort().forEach(category => {
          changelog += `### ${category}\n`;
          categorizedCommits[category].forEach(commit => {
            changelog += `- ${commit.message}\n`;
          });
          changelog += '\n';
        });
      }
    }
  }
  
  return changelog;
}

// Main function
function main() {
  try {
    console.log('Rebuilding changelog from git history...');
    
    // Check if we're in a git repository
    try {
      execSync('git rev-parse --is-inside-work-tree');
    } catch (error) {
      console.error('Error: Not in a git repository. Please run this script from within a git repository.');
      process.exit(1);
    }
    
    // Check if git is installed
    try {
      execSync('git --version');
    } catch (error) {
      console.error('Error: Git is not installed or not in PATH.');
      process.exit(1);
    }
    
    const changelog = generateChangelog();
    
    if (!changelog || changelog.trim() === '# Changelog\n\n') {
      console.warn('Warning: Generated changelog is empty. This might indicate an issue with git history access.');
      
      // Check if we have any commits at all
      try {
        const commitCount = execSync('git rev-list --count HEAD').toString().trim();
        console.log(`Repository has ${commitCount} commits.`);
        
        if (parseInt(commitCount) > 0) {
          console.log('Attempting to generate a basic changelog...');
          
          // Generate a very basic changelog as fallback
          let basicChangelog = '# Changelog\n\n## [1.0.0] - Initial Release\n\n';
          basicChangelog += '### Added\n- Initial version\n\n';
          
          // Write the basic changelog
          fs.writeFileSync(config.changelogPath, basicChangelog);
          console.log(`Basic changelog written to ${config.changelogPath}`);
          return;
        }
      } catch (error) {
        console.error('Error checking commit count:', error.message);
      }
      
      console.error('Failed to generate changelog.');
      process.exit(1);
    }
    
    // Create backup of existing changelog if it exists
    if (fs.existsSync(config.changelogPath)) {
      const backupPath = `${config.changelogPath}.bak`;
      fs.copyFileSync(config.changelogPath, backupPath);
      console.log(`Backup created at ${backupPath}`);
    }
    
    // Write new changelog
    fs.writeFileSync(config.changelogPath, changelog);
    console.log(`Changelog successfully written to ${config.changelogPath}`);
  } catch (error) {
    console.error('Error rebuilding changelog:', error);
    process.exit(1);
  }
}

// Run the script
main(); 