import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CustomerService } from './customer.service.js';
import { CustomerMessageService } from './customer-message.service.js';

interface AuthRequest extends Request {
  user: { id: string; email: string; name: string };
}

@UseGuards(JwtAuthGuard)
@Controller('customers')
export class CustomerController {
  constructor(
    private readonly customerService: CustomerService,
    private readonly customerMessageService: CustomerMessageService,
  ) {}

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    if (
      page !== undefined ||
      pageSize !== undefined ||
      search !== undefined
    ) {
      return this.customerService.findPage({
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
        search,
      });
    }

    return this.customerService.findAll();
  }

  @Get(':id/messages')
  listMessages(@Param('id', ParseUUIDPipe) id: string) {
    return this.customerMessageService.listForCustomer(id);
  }

  @Post(':id/messages')
  sendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { text?: string },
    @Req() req: AuthRequest,
  ) {
    return this.customerMessageService.sendOutbound(
      id,
      body?.text ?? '',
      req.user.id,
    );
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.customerService.findOne(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.customerService.remove(id);
  }
}
