import { ThemeIcon, Uri } from 'vscode';

export type TrendLevel = 0 | 1 | 2 | 3;

export function getTrendLevel(percent: number): TrendLevel {
  if (percent > 5) {
    return 3;
  }
  if (percent > 2) {
    return 2;
  }
  if (percent > 0) {
    return 1;
  }
  if (percent < -5) {
    return 3;
  }
  if (percent < -2) {
    return 2;
  }
  if (percent < 0) {
    return 1;
  }
  return 0;
}

export function getTrendIcon(
  extensionUri: Uri,
  percent: number
): ThemeIcon | { light: Uri; dark: Uri } {
  const level = getTrendLevel(percent);
  if (level === 0) {
    return new ThemeIcon('minus');
  }

  const direction = percent > 0 ? 'up' : 'down';
  const iconUri = Uri.joinPath(extensionUri, 'resources', 'trend', `${direction}-${level}.svg`);
  return { light: iconUri, dark: iconUri };
}
