import { TransformFnParams } from 'class-transformer';

/** Use with @Transform(emailToLowercaseTransform) on email fields. */
export function emailToLowercaseTransform({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
