import {EventEmitter} from "events";
import {ClientOptions, WebSocket} from 'ws'
import {Intends, MAX_RETRY, OpCode, SessionEvents, WebsocketCloseReason} from "@/constans";
import {Bot} from "@/bot";
import {toObject} from "@/utils";
import {HttpsProxyAgent} from "https-proxy-agent";

export class SessionManager extends EventEmitter {
  public wsUrl: string=`wss://gateway.discord.gg/?v=10&encoding=json`;
  retry: number = 0;
  alive?: boolean;
  heartbeatInterval?: number;
  isReconnect?: boolean;
  sessionRecord = {
    sessionID: "",
    seq: 0
  };
  heartbeatParam = {
    op: OpCode.HEARTBEAT,
    d: null // 心跳唯一值
  };
  get token(){
    return this.bot.options.token
  }
  constructor(private bot: Bot) {
    super();
    this.on(SessionEvents.EVENT_WS, (data) => {
      switch (data.eventType) {
        case SessionEvents.RECONNECT:
          this.bot.logger.debug("[CLIENT] 等待断线重连中...");
          break;
        case SessionEvents.DISCONNECT:
          if (this.retry < (this.bot.options.max_reconnect_count || MAX_RETRY)) {
            this.bot.logger.debug("[CLIENT] 重新连接中，尝试次数：", this.retry + 1);
            if (WebsocketCloseReason.find((v) => v.code === data.code)?.resume) {
              this.sessionRecord = data.eventMsg;
            }
            this.isReconnect = true
            this.start();
            this.retry += 1;
          } else {
            this.bot.logger.debug("[CLIENT] 超过重试次数，连接终止");
            this.emit(SessionEvents.DEAD, {
              eventType: SessionEvents.ERROR,
              msg: "连接已死亡，请检查网络或重启"
            });
          }
          break;
        case SessionEvents.READY:
          this.bot.logger.debug("[CLIENT] 连接成功");
          this.retry = 0;
          break;
        default:
      }
    });
    this.on(SessionEvents.ERROR, (e) => {
      this.bot.logger.error(`[CLIENT] 发生错误：${e}`);
    })
  }


  async start() {
    this.connect();
    this.startListen();
  }
  connect() {
    const options:ClientOptions={
      headers: {
        "Authorization": "Bot " + this.token,
      }
    }
    if(this.bot.options.proxy){
      options.agent=new HttpsProxyAgent(
          `http://${this.bot.options.proxy.host}:${this.bot.options.proxy.port}`
      )
    }
    this.bot.ws = new WebSocket(this.wsUrl, options);
  }

  reconnectWs() {
    const reconnectParam = {
      op: OpCode.RESUME,
      d: {
        // token: `Bot ${this.bot.appId}${this.token}`,
        token:this.token,
        session_id: this.sessionRecord.sessionID,
        seq: this.sessionRecord.seq
      }
    };
    this.sendWs(reconnectParam);
  }

  // 发送websocket
  sendWs(msg: unknown) {
    try {
      // 先将消息转为字符串
      this.bot.ws!.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    } catch {}
  }

  authWs() {
    this.sendWs(this.heartbeatParam);
    this.sendWs({
      op:OpCode.IDENTIFY,
      d:{
        token:this.token,
        intents: this.getValidIntends(), // todo 接受的类型
        properties:{
          os:'linux',
          browser:'ts-discord-bot',
          device:'ts-discord-bot'
        }
      }
    })
  }

  startListen() {
    this.bot.ws!.on('open',()=>{
      this.bot.logger.log('connect open')
    })
    this.bot.ws!.on("close", (code) => {
      this.alive = false;
      this.bot.logger.error(`[CLIENT] 连接关闭：${code}`);
      this.emit(SessionEvents.EVENT_WS, {
        eventType: SessionEvents.DISCONNECT,
        code,
        eventMsg: this.sessionRecord
      });
      if (code) {
        WebsocketCloseReason.forEach((e) => {
          if (e.code === code) {
            this.emit(SessionEvents.ERROR, e.reason);
          }
        });
      }
    });
    this.bot.ws!.on("error", (e) => {
      this.alive = false
      this.bot.logger.debug("[CLIENT] 连接错误");
      this.emit(SessionEvents.CLOSED, {eventType: SessionEvents.CLOSED});
    });
    this.bot.ws!.on("message", (data) => {
      this.bot.logger.debug(`[CLIENT] 收到消息: ${data}`);
      // 先将消息解析
      const wsRes = toObject(data);
      // 先判断websocket连接是否成功
      if (wsRes?.op === OpCode.HELLO && wsRes?.d?.heartbeat_interval) {
        // websocket连接成功，拿到心跳周期
        this.heartbeatInterval = wsRes?.d?.heartbeat_interval;
        // 非断线重连时，需要鉴权
        this.isReconnect ? this.reconnectWs() : this.authWs();
        return;
      }

      // 鉴权通过
      if (wsRes.t === SessionEvents.READY) {
        this.bot.logger.debug(`[CLIENT] 鉴权通过`);
        const {d, s} = wsRes;
        const {session_id, user = {}} = d;
        this.bot.self_id = user.id;
        this.bot.nickname = user.username;
        this.bot.status = user.status || 0;
        // 获取当前会话参数
        if (session_id && s) {
          this.sessionRecord.sessionID = session_id;
          this.sessionRecord.seq = s;
          this.heartbeatParam.d = s;
        }
        this.bot.logger.info(`connect to ${user.username}(${user.id})`)
        this.isReconnect = false
        this.emit(SessionEvents.READY, {eventType: SessionEvents.READY, msg: d || ""});
        // 第一次发送心跳
        this.bot.logger.debug(`[CLIENT] 发送第一次心跳`, this.heartbeatParam);
        this.sendWs(this.heartbeatParam);
        return;
      }
      // 心跳测试
      if (wsRes.op === OpCode.HEARTBEAT_ACK || wsRes.t === SessionEvents.RESUMED) {
        if (!this.alive) {
          this.alive = true;
          this.emit(SessionEvents.EVENT_WS, {eventType: SessionEvents.READY});
        }
        this.bot.logger.debug("[CLIENT] 心跳校验", this.heartbeatParam);
        setTimeout(() => {
          this.sendWs(this.heartbeatParam);
        }, this.heartbeatInterval);
      }

      // 收到服务端重连的通知
      if (wsRes.op === OpCode.RECONNECT) {
        // 通知会话，当前已断线
        this.emit(SessionEvents.EVENT_WS, {eventType: SessionEvents.RECONNECT});
      }

      // 服务端主动推送的消息
      if (wsRes.op === OpCode.DISPATCH) {
        // 更新心跳唯一值
        const {s} = wsRes;
        if (s) this.sessionRecord.seq = this.heartbeatParam.d = s;
        // OpenAPI事件分发
        this.bot.dispatchEvent(wsRes.t, wsRes);
      }
    });
  }

  getValidIntends() {
    if(typeof this.bot.options.intents==='number') return this.bot.options.intents
    return (this.bot.options.intents || []).reduce((result, item) => {
      const value = Intends[item];
      if (value === undefined) {
        this.bot.logger.warn(`Invalid intends(${item}),skip...`);
        return result;
      }
      return Intends[item as unknown as keyof Intends] | result;
    }, 0);
  }
}
