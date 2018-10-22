import { ChangeDetectorRef, Component, NgZone, ViewChild } from '@angular/core'
import { AlertController, App, IonicPage, LoadingController, NavController, NavParams, Platform, PopoverController, ToastController } from 'ionic-angular'
import { QRScanner, QRScannerStatus } from '@ionic-native/qr-scanner'
import { SocialSharing } from '@ionic-native/social-sharing'
import { StatusBar } from '@ionic-native/status-bar'
import { Clipboard } from '@ionic-native/clipboard'
import { Keyboard } from '@ionic-native/keyboard'
import { TranslateService } from '@ngx-translate/core';
import { Wallet } from '../../providers/providers'

@IonicPage()
@Component({
  selector: 'page-home',
  templateUrl: 'home.html'
})
export class HomePage {

  private address: string
  private displayedAddress: string
  private amount: number
  private qrCodeURL: string
  private isSharing: boolean = false

  private updateCallback: Function
  private priceCallback: Function

  private cameraAccess: boolean = false
  private pauseSub: any
  private scanSub: any
  private scanState: string = 'stopped'
  private isTransparent: boolean = false

  private scanBeginTime: number
  private scanEndTime: number

  private hint: any
  private hintTimer: number

  private firstTimeEnter: boolean = true
  private clipboardContent: string = ''
  private resumeSub: any

  private timestamp: number

  constructor(
    public alertCtrl: AlertController,
    private app: App,
    private ref: ChangeDetectorRef,
    private clipboard: Clipboard,
    private keyboard: Keyboard,
    public loadingCtrl: LoadingController,
    public navCtrl: NavController,
    private ngZone: NgZone,
    private platform: Platform,
    public popoverCtrl: PopoverController,
    private qrScanner: QRScanner,
    private socialSharing: SocialSharing,
    private statusBar: StatusBar,
    private toastCtrl: ToastController,
    private translate: TranslateService,
    private wallet: Wallet
  ) {
    this.updateCallback = () => {
      this.refresh()
    }
    this.priceCallback = () => {
      this.timestamp = new Date().getTime()
    }
    this.qrScanner.prepare().then((status: QRScannerStatus) => {
      if (status.authorized) {
        this.cameraAccess = true
      }
      return this.qrScanner.destroy()
    }).catch((err: any) => {

    })
  }

  ionViewWillEnter() {
    this.wallet.subscribeUpdate(this.updateCallback)
    this.wallet.subscribePrice(this.priceCallback)
    this.priceCallback()
    this.resumeSub = this.platform.resume.subscribe(() => {
      this.handleClipboard()
    })
    this.handleClipboard()
  }

  ionViewDidEnter() {
    if (this.firstTimeEnter) {
      this.firstTimeEnter = false
      this.handleDeepLinks()
    }
  }

  ionViewDidLeave() {
    this.wallet.unsubscribeUpdate(this.updateCallback)
    this.wallet.unsubscribePrice(this.priceCallback)
    this.resumeSub.unsubscribe()
  }

  ionViewWillUnload() {

  }

  refresh() {
    this.address = this.wallet.getCacheReceiveAddress()
    // return this.updateQR()
  }

  addressChange(ev: any) {
    this.displayedAddress = ev.value
    return this.updateQR()
  }

  amountChange(sat: number) {
    this.amount = sat
    return this.updateQR()
  }

  updateQR() {
    let text = this.wallet.getPaymentRequestURL(this.displayedAddress, this.amount)
    return this.wallet.getQR(text).then((url) => {
      this.qrCodeURL = url
    }).catch((err: any) => {
      console.log(err)
    })
  }

  async share() {
    if (this.isSharing) {
      return
    }
    let message: string = `${this.translate.instant('MY_BITCOIN_CASH_ADDRESS')}:\n${this.displayedAddress}\n\n`
    let link: string = 'https://simply.cash/send'
    if (this.amount > 0) {
      let amount: string = this.wallet.convertUnit('SATS', 'BCH', this.amount.toString()).replace(/\.?0+$/,'')
      message += `${this.translate.instant('REQUEST_AMOUNT')}:\n${amount} BCH\n\n`
      link += '-' + amount
    }
    link += `-BCH-to-${this.displayedAddress}`
    message += `${this.translate.instant('SIMPLY_LAUNCH')}:\n${link}`
    this.isSharing = true
    try {
      await this.socialSharing.share(message)
    } catch (err) {
      console.log(err)
    }
    this.isSharing = false
  }

  reconnect(ev: any) {
    this.wallet.tryToConnectAndSync()
  }

  async startScan() {
    try {
      if (this.scanState !== 'stopped') {
        return
      }
      if (typeof this.hint !== 'undefined') {
        this.hint.dismiss()
      }
      this.scanState = 'starting'
      this.scanBeginTime = new Date().getTime()
      let status: QRScannerStatus = await this.qrScanner.prepare()
      if (!status.authorized) {
        throw new Error('permission denied')
      }
      if (!this.cameraAccess) {
        this.cameraAccess = true
        await this.destroyScanner()
        return
      }
      if (this.scanState === 'stopping') {
        await this.destroyScanner()
        return
      }
      this.scanState = 'scanning'
      this.pauseSub = this.platform.pause.subscribe(() => {
        this.ngZone.run(async () => {
          await this.stopScan()
        })
      })
      this.scanSub = this.qrScanner.scan().subscribe((text: string) => {
        this.scanState = 'processing'
        this.ngZone.run(async () => {
          await this.stopScan(true)
          await this.handleQRText(text)
          this.isTransparent = false
          this.ref.detectChanges()
          await this.destroyScanner()
        })
      })
      this.isTransparent = true
      // this.statusBar.hide()
      this.qrScanner.show()
    } catch (err) {
      console.log(err)
      this.scanState = 'stopped'
      if (err.message === 'permission denied' || err.name === 'CAMERA_ACCESS_DENIED') {
        await this.alertCtrl.create({
          enableBackdropDismiss: false,
          title: this.translate.instant('ERROR'),
          message: this.translate.instant('ERR_CAMERA_PERMISSION_DENIED'),
          buttons: ['ok']
        }).present()
      }
    }
  }

  async stopScan(keepPreview?: boolean) {
    if (this.scanState === 'stopped'
    || this.scanState === 'stopping'
    || this.scanState === 'willDestroy'
    || this.scanState === 'destroying'
    || this.scanState === 'processing') {
      return
    }
    this.scanEndTime = new Date().getTime()
    if (this.scanEndTime - this.scanBeginTime < 500) {
      if (typeof this.hint === 'undefined') {
        this.hint = this.toastCtrl.create({
          message: this.translate.instant('CAMERA_BUTTON_HINT'),
          position: 'middle',
          dismissOnPageChange: true
        })
        this.hint.onWillDismiss(() => {
          window.clearTimeout(this.hintTimer)
          this.hint = undefined
        })
        this.hint.present()
      } else {
        window.clearTimeout(this.hintTimer)
      }
      this.hintTimer = window.setTimeout(() => {
        this.hint.dismiss()
      }, 3000)
    }
    if (this.scanState === 'starting') {
      this.scanState = 'stopping'
      return
    }
    this.pauseSub.unsubscribe()
    this.scanSub.unsubscribe() // stop scanning
    if (!keepPreview) {
      this.isTransparent = false
      this.scanState = 'willDestroy'
      window.setTimeout(() => {
        this.destroyScanner()
      }, 200)
    }
    // this.statusBar.show()
    // this.qrScanner.hide()
  }

  async destroyScanner() {
    this.scanState = 'destroying'
    await this.qrScanner.destroy()
    this.scanState = 'stopped'
  }

  showMenu(myEvent: any) {
    this.popoverCtrl.create('SettingsPage').present({
      ev: myEvent
    })
  }

  copyAddress() {
    let a: string = this.displayedAddress
    this.clipboard.copy(a).then(() => {
      this.handleClipboard()
    })
  }

  async handleQRText(text: string) {
    if (await this.handleURL(text)) {
      return true
    }
    if (this.wallet.validateWIF(text)) {
      await this.navCtrl.push('SweepPage', {
        wif: text
      })
      return true
    }
    await this.alertCtrl.create({
      enableBackdropDismiss: false,
      title: this.translate.instant('ERR_INVALID_DATA'),
      message: text,
      buttons: ['ok']
    }).present()
    return false
  }

  async handleURL(url: string) {
    let info: any = this.wallet.getRequestFromURL(url)
    if (typeof info === 'undefined') {
      return false
    }
    if (typeof info.url !== 'undefined') {
      await this.handleBIP70(info)
      return true
    } else {
      return await this.handleRequest(info)
    }
  }

  async handleRequest(info: any) {
    if (info.outputs.length === 0) {
      return false
    }
    await this.navCtrl.push('SendPage', {
      info: info
    })
    return true
  }

  async handleBIP70(info: any) {
    let loader = this.loadingCtrl.create({
      content: this.translate.instant('LOADING')+'...'
    })
    await loader.present()
    let request: any
    let errMessage: string
    try {
      request = await this.wallet.getRequestFromMerchant(info.url)
    } catch (err) {
      console.log(err)
      if (err.message === 'unsupported network') {
        errMessage = this.translate.instant('ERR_UNSUPPORTED_NETWORK')
      } else if (err.message === 'expired') {
        errMessage = this.translate.instant('ERR_EXPIRED')
      } else {
        errMessage = this.translate.instant('ERR_GET_REQUEST_FAIlED')
      }
    }
    await loader.dismiss()
    if (typeof errMessage === 'undefined') {
      return await this.handleRequest(request)
    } else {
      this.alertCtrl.create({
        enableBackdropDismiss: false,
        title: this.translate.instant('ERROR'),
        message: errMessage,
        buttons: ['ok']
      }).present()
      // fallback
      // this.handleRequest(info)
    }
  }

  handleDeepLinks() {

    // Check if app was resume by custom url scheme
    (window as any).handleOpenURL = (url: string) => {
      if (this.platform.is('ios') && url.indexOf('bitcoincash:') !== 0) {
        return
      }
      if (
        this.app._appRoot._overlayPortal.getActive() ||
        this.app._appRoot._loadingPortal.getActive() ||
        this.app._appRoot._modalPortal.getActive() ||
        this.app._appRoot._toastPortal.getActive()
      ) {
        return
      }
      window.setTimeout(() => {
        this.ngZone.run(async () => {
          if (await this.handleURL(url)) {
            return
          }
          await this.alertCtrl.create({
            enableBackdropDismiss: false,
            title: this.translate.instant('ERR_INVALID_DATA'),
            message: url,
            buttons: ['ok']
          }).present()
        })
      }, 0)
      return true
    }

    // Check if app was opened by custom url scheme
    const lastUrl: string = (window as any).handleOpenURL_LastURL || ''
    if (lastUrl !== '') {
      delete (window as any).handleOpenURL_LastURL;
      (window as any).handleOpenURL(lastUrl)
    }
  }

  handleClipboard() {
    this.clipboard.paste().then((content: string) => {
      if (!content || typeof this.wallet.getRequestFromURL(content) === 'undefined') {
        this.clipboardContent = ''
        return
      }
      let af: string = this.wallet.getAddressFormat(content)
      if (typeof af !== 'undefined' && this.wallet.isMyReceiveAddress(this.wallet.convertAddress(af, 'legacy', content))) {
        this.clipboardContent = ''
      } else {
        this.clipboardContent = content
      }
    }).catch((err: any) => {

    })
  }

  quickSend() {
    this.handleURL(this.clipboardContent)
  }

  clearClipboard() {
    this.clipboard.copy('').then(() => {
      this.clipboardContent = ''
    })
  }

}
