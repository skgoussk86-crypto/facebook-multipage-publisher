export function isEnglishOnly(str: string): boolean {
  // Permits basic English characters, numbers, punctuation, whitespace, and emojis
  const englishRegex = /^[a-zA-Z0-9\s.,!?'"()#@_\-+*/\\%&$:;<>=\[\]{}~`|\u00a9\u00ae\u2122\u200d\u2600-\u27bf\u1f300-\u1f9ff\u1f600-\u1f64f]*$/;
  return englishRegex.test(str);
}

export function validateJobInput(data: {
  englishTitle: string;
  englishCaption?: string;
  hashtags?: string;
  scheduledTimeUTC: string;
  pageId: string;
}): string[] {
  const errors: string[] = [];

  if (!data.englishTitle || data.englishTitle.trim() === '') {
    errors.push('English Title is required.');
  } else {
    if (data.englishTitle.length > 255) {
      errors.push('English Title must not exceed 255 characters.');
    }
    if (!isEnglishOnly(data.englishTitle)) {
      errors.push('English Title must contain only English characters, standard punctuation, and emojis.');
    }
  }

  if (data.englishCaption && !isEnglishOnly(data.englishCaption)) {
    errors.push('English Caption must contain only English characters, standard punctuation, and emojis.');
  }

  if (data.hashtags && !isEnglishOnly(data.hashtags)) {
    errors.push('Hashtags must contain only English characters, standard punctuation, and emojis.');
  }

  const date = new Date(data.scheduledTimeUTC);
  if (isNaN(date.getTime())) {
    errors.push('Invalid scheduled publishing time format.');
  } else if (date.getTime() <= Date.now()) {
    errors.push('Scheduled publishing time must be in the future.');
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!data.pageId || !uuidRegex.test(data.pageId)) {
    errors.push('Invalid target Facebook Page ID.');
  }

  return errors;
}
