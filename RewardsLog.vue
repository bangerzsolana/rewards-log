<template>
 <Flex style="padding-top: calc(var(--realHeaderHeight) + var(--top))" :class="{mobile:mobile?.value}" class="pad4 all" :vertical="true" gap="16px">
    <GibPondBackground class="pondbg" />
    <Back :click="hasBack ? backInHistory : goHome" class="capi black boton bordered specialborder" style="padding-left:calc(var(--padding) * 4) !important; padding-right:calc(var(--padding) * 4) !important; z-index: 4;color: var(--popup-primary-contrast) !important; border-color: var(--popup-primary-contrast) !important;" :label="hasBack ? d('back') : d('hub')" />

    <Flex class="totals vcenter" :grid="true" gap="12px">
      <Flex v-for="(val,key) in totals" class="vcenter pad6 whmi squared bordered black hcenter">
        <div class="bigger game-font nowrap">{{ thousandify(val?.amountParsed) }} {{ val?.token?.symbol || 'SOL' }}</div>
      </Flex>
    </Flex>
     <!--<Flex
      class="overlista customScroll medScroll hideScroll"
      infinite-holder
    >-->
       <NFTList
            v-if="searchby"
            class="lista"
            :extraHeight="0"
            :squared="false"
            type="list"
            direction="y"
            container="site"
            :size="cardSizes"
            :props="{button:'selection'}"
            ref="list"
            :mix="mix"
            :groupby="null"
            :on="on"
            :grid="false"
            @clicked="clickCard"
            :searchby="searchby"
            component="GibRewardRow"
        >
        <template v-slot:empty>
          <slot name="empty" />
        </template>
      </NFTList>
   <!-- </Flex>-->

 </Flex>
 <GibBottom/>
</template>

<script>
import { mix, langmix, hashmix } from "@/components/mixin";
import { errormix } from "@/components/mixin/error";
import { accountmix } from "@/components/mixin/account";
import { collectmix } from "@/components/mixin/collect";
import { cnftpaymix } from "@/components/mixin/cnftpay";
import { gibmix } from "@/components/mixin/gib";
import { app } from "@/services/app";
import { app_info } from "@/config";
import { dictionary } from "@/services/app";
import { request } from "@/services/request";
import { sleep } from "@/base";
import bs58 from "bs58";
import BN from "bn.js";
import { GibMeme, GlobalGibMeme } from "@/services/anchor/gibmeme";
import { Stores, findAssociatedTokenAccountAddress2 } from "@/services/anchor";
import { modal } from "@/services/modals";
import { file } from "@/services/file";
import {  decodeAsciiStringToBytes,  bytesTo16, thousandify, bytesTo32, bytesTo64, } from "@/base/shared";
import { formatNumber, getConnection,searchDASAsset,decodeAsciiStringToU64} from "@/services/tight-solana";
export const words = dictionary.load([
  "views/Secret/dictionary/",
]);
const stores = new Stores();
stores.init({ wallet: null });
export default {
  mixins: [mix, langmix, collectmix, errormix, cnftpaymix, accountmix, hashmix, gibmix],
  data() {
    return {
      totals:{},
      lastIndex:Infinity,
      tournaments:[],
      mobile:app.mobile(600)
    };
  },
  computed:{
    cardSizes() {
      return { min: 60, max: 60 };
    },
    searchby(){
       const wallet = this.session?.profile?.address;
       console.log("wallet",wallet)
        if(!wallet || !this.tournaments?.length) return;
        return {
          custom: async ({ cache, size, page, options }) => {
console.log("GETTING PAGE",page, this.lastIndex );
            //const [tournament] = await anchor.tournamentPDA({ index });
            let tournaments = [];
            if(page==0){
              this.tournaments.forEach(t=>{
                this.lastIndex = Math.min(this.lastIndex, t.index);
              })
              tournaments = (await Promise.all(this.tournaments.map(x=>GlobalGibMeme.getTournamentRewards({tournament:x.tournament, wallet}))))?.filter?.(x=>Object.keys(x?.myPositions||{}).length);
            } else {
              const nextTournaments = (await Promise.all([1,2,3,4,5,6].map(x=>GlobalGibMeme.anchor.tournamentPDA({index:this.lastIndex-x})))).map(x=>x[0]);
              this.lastIndex = this.lastIndex-6;
              tournaments = (await Promise.all(nextTournaments.map(x=>GlobalGibMeme.getTournamentRewards({tournament:x, wallet}))))?.filter?.(x=>Object.keys(x?.myPositions||{}).length);
            }

            const items = tournaments.map(x=>{
              const positions = Object.keys(x?.myPositions||{}).map(y=>({round:y, amount:x?.myPositions?.[y]}));
              return {positions, prizes:x.prizes, players:x.players, id:x.id, tournament:x.tournament, ended:x.ended}
            }).filter(x=>x?.positions?.length);


            let totalGot = items?.length||1;
            if(this.lastIndex<50) totalGot += 1; //stop asking for more pages
            console.log("this.lastIndex",this.lastIndex,totalGot, tournaments?.length)

            return { items, limit: tournaments.length, total: totalGot};
          }
        }
    }
  },
  methods:{
    thousandify,
    async onUserLoaded(){
      this.loadTournamentsBase();
      const wallet = this.session?.profile?.address;
      if(!wallet) return
      this.totals = await GlobalGibMeme.getTotalRewards({wallet,test:true})
    },
    async loadTournamentsBase(){
      const wallet = this.session?.profile?.address;
      if(!wallet) return
      this.tournaments = (await GlobalGibMeme.getFastTournaments({wallet:null}))?.data?.data;
    },
    goHome() {
      this.redirect("/");
    },
  },
  props: {

  },
  async mounted() {
    this.$root.gameLoader = null;
  },
};
</script>

<style lang="scss" scoped>
.totals
{
  overflow-x: scroll;
  scrollbar-width: none;
  overflow-y: hidden;
  min-height:var(--totalHeight) !important;
}
.all {
  --totalHeight:100px;
  --block-gaps: 12px;
  min-height: calc(100dvh - 120px);
}
.all.mobile .lista
{
  min-height: calc(100dvh - 180px - var(--headerHeight) - 72px - var(--totalHeight));
}
.lista
{
  min-height: calc(100dvh - 120px - var(--headerHeight) - 72px - var(--totalHeight));
}
.all.mobile
{
  min-height: calc(100dvh - 180px);
}
 .overlista {
  overflow-x: hidden;
  min-height: 400px;
}
.pondbg
{
  position: fixed !important;
  left:0px;
  top:0px;
  width: 100dvw !important;
  height: 100dvh !important;
}
</style>
