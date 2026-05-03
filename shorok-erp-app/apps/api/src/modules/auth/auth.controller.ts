import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LoginRequestSchema, type LoginRequest, type LoginResponse } from "@shorok/shared";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import type { AuthenticatedUser } from "../../common/types/request-user";

const REFRESH_COOKIE = "shorok_refresh";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body, req.header("user-agent"));
    this.setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    return { accessToken: result.accessToken, expiresInSec: result.expiresInSec };
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const raw = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? "";
    const result = await this.auth.refresh(raw, req.header("user-agent"));
    this.setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt);
    return { accessToken: result.accessToken, expiresInSec: result.expiresInSec };
  }

  @Post("logout")
  @HttpCode(204)
  @UseGuards(JwtAuthGuard)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    await this.auth.logout(raw, user.id);
    this.clearRefreshCookie(res);
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  private setRefreshCookie(res: Response, value: string, expiresAt: Date): void {
    res.cookie(REFRESH_COOKIE, value, {
      httpOnly: true,
      secure: this.config.get<string>("NODE_ENV") === "production",
      sameSite: "lax",
      expires: expiresAt,
      path: "/api/v1/auth",
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
  }
}
