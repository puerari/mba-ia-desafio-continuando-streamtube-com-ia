import {
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class InitUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @IsString()
  @IsNotEmpty()
  content_type: string;

  /**
   * Client-declared size. Validated against the configured maximum in the
   * service — the upper bound is a configuration value, not a DTO constant.
   */
  @IsInt()
  @Min(1)
  size_bytes: number;
}
