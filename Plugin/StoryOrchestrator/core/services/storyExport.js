'use strict';

function exportAsMarkdown(story) {
  const chapters = story.phase3?.polishedChapters || story.phase2?.chapters || [];
  const lines = [`# ${story.title || story.config?.title || '故事创作'}`, ''];

  if (story.phase1?.worldview?.setting) {
    lines.push('## 世界观', '', story.phase1.worldview.setting, '');
  }

  chapters.forEach((chapter, index) => {
    const chapterNumber = chapter.number || chapter.chapterNum || chapter.chapterNumber || (index + 1);
    const title = chapter.title || `第${chapterNumber}章`;
    const cleanContent = chapter.content || '';

    lines.push(`## ${title}`, '', cleanContent, '');
  });

  return lines.join('\n');
}

function exportAsPlainText(story) {
  const chapters = story.phase3?.polishedChapters || story.phase2?.chapters || [];
  return chapters.map((chapter) => chapter.content || '').join('\n\n');
}

function exportStoryContent(story, format) {
  switch (format) {
    case 'json':
      return JSON.stringify(story, null, 2);
    case 'txt':
      return exportAsPlainText(story);
    case 'markdown':
    default:
      return exportAsMarkdown(story);
  }
}

module.exports = {
  exportAsMarkdown,
  exportAsPlainText,
  exportStoryContent
};
