export interface IRTILogger {
  /**
   * Send log message to RTI Logger
   * @param level
   * @param message
   * @param action
   */
  log(level: 'audit' | 'error' | 'info' | 'warn', message: string, action?: string): Promise<void>;

  /**
   * Send error message to RTI Logger
   * @param message
   * @param action
   */
  error(message: string, action?: string): Promise<void>;

  /**
   * Send info message to RTI Logger
   * @param message
   * @param action
   */
  info(message: string, action?: string): Promise<void>;
}
