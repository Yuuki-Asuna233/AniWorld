// AniList → OIAPI 搜索别名表（不是翻译表！）
// 
// 作用：当 OIAPI 用 AniList 的 native/romaji/english 标题直接搜不到时，
//       用这里配置的别名作为备用搜索词。
//
// 原则：
// 1. OIAPI 能直接用原生标题翻译的番，不要加到这里（避免覆盖正确翻译）
// 2. 只加那些"必须用中文别名才能搜到"的番
// 3. 新番（七月番、十月番等）通常不需要加，直接用原生标题搜即可
//
// 键：小写去空格后的 romaji/english/native 标题
// 值：OIAPI 搜索别名（通常是中文名）

const TITLE_MAP = new Map();

function add(key, chinese) {
  // Use normalize() to keep key format consistent with findChinese() lookups
  if (key) TITLE_MAP.set(normalize(key), chinese);
}

// ======================= 2026年春季新番 =======================
add('YominoTsugai', '黄泉使者');
add('黄泉のツガイ', '黄泉使者');
add('DaemonsoftheShadowRealm', '黄泉使者');
add('TenseiShitaraSlimeDattaKen4thSeason', '关于我转生变成史莱姆这档事');
add('転生したらスライムだった件第4期', '关于我转生变成史莱姆这档事');
add('転生したらスライムだった件', '关于我转生变成史莱姆这档事');
add('ThatTimeIGotReincarnatedasaSlimeSeason4', '关于我转生变成史莱姆这档事');
add('ThatTimeIGotReincarnatedasaSlime', '关于我转生变成史莱姆这档事');
add('TsueToTsuruginoWistoriaSeason2', '杖与剑的魔剑谭');
add('杖と剣のウィストリア第2期', '杖与剑的魔剑谭');
add('WistoriaWandandSwordSeason2', '杖与剑的魔剑谭');
add('OnePiece', '海贼王');
add('ワンピース', '海贼王');
add('BokuNoHeroAcademia', '我的英雄学院');
add('僕のヒーローアカデミア', '我的英雄学院');
add('MyHeroAcademia', '我的英雄学院');

// ======================= 热门经典 =======================
add('DetectiveConan', '名侦探柯南');
add('MeitanteiConan', '名侦探柯南');
add('名探偵コナン', '名侦探柯南');
add('CaseClosed', '名侦探柯南');
add('Doraemon', '哆啦A梦');
add('ドラえもん', '哆啦A梦');
add('PocketMonsters', '精灵宝可梦');
add('Pokémon', '精灵宝可梦');
add('ポケットモンスター', '精灵宝可梦');
add('ShingekiNoKyojin', '进击的巨人');
add('進撃の巨人', '进击的巨人');
add('AttackonTitan', '进击的巨人');
add('KimetsuNoYaiba', '鬼灭之刃');
add('鬼滅の刃', '鬼灭之刃');
add('DemonSlayer', '鬼灭之刃');
add('JujutsuKaisen', '咒术回战');
add('呪術廻戦', '咒术回战');
add('Naruto', '火影忍者');
add('ナルト', '火影忍者');
add('NarutoShippuuden', '火影忍者疾风传');
add('ナルト疾風伝', '火影忍者疾风传');
add('Bleach', '死神');
add('ブリーチ', '死神');
add('BLEACH死神千年血战篇', '死神');
add('DragonBall', '龙珠');
add('ドラゴンボール', '龙珠');
add('DragonBallZ', '龙珠Z');
add('DragonBallSuper', '龙珠超');
add('ドラゴンボール超', '龙珠超');
add('FullmetalAlchemist', '钢之炼金术师');
add('鋼の錬金術師', '钢之炼金术师');
add('FullmetalAlchemistBrotherhood', '钢之炼金术师FA');
add('SteinsGate', '命运石之门');
add('シュタインズゲート', '命运石之门');
add('HunterxHunter', '全职猎人');
add('HUNTER×HUNTER', '全职猎人');
add('ハンター×ハンター', '全职猎人');
add('HUNTERxHUNTER', '全职猎人');
add('DeathNote', '死亡笔记');
add('デスノート', '死亡笔记');
add('CodeGeass', '叛逆的鲁路修');
add('コードギアス', '叛逆的鲁路修');
add('SwordArtOnline', '刀剑神域');
add('ソードアートオンライン', '刀剑神域');
add('RE0', '从零开始的异世界生活');
add('ReZero', '从零开始的异世界生活');
add('Re:ゼロから始める異世界生活', '从零开始的异世界生活');
add('ReZerokaraHajimeruIsekaiSeikatsu', '从零开始的异世界生活');
add('VioletEvergarden', '紫罗兰永恒花园');
add('ヴァイオレットエヴァーガーデン', '紫罗兰永恒花园');
add('YourName', '你的名字');
add('君の名は', '你的名字');
add('SpiritedAway', '千与千寻');
add('千と千尋の神隠し', '千与千寻');
add('WeatheringWithYou', '天气之子');
add('天気の子', '天气之子');
add('Suzume', '铃芽之旅');
add('すずめの戸締まり', '铃芽之旅');
add('KonoSubarashiiSekainiShukufukuwo', '为美好的世界献上祝福');
add('この素晴らしい世界に祝福を', '为美好的世界献上祝福');
add('MushokuTensei', '无职转生');
add('無職転生', '无职转生');
add('Overlord', 'OVERLORD');
add('オーバーロード', 'OVERLORD');
add('NoGameNoLife', '游戏人生');
add('ノーゲームノーライフ', '游戏人生');
add('FateStayNight', '命运之夜');
add('FateZero', 'Fate/Zero');
add('FateStayNightUnlimitedBladeWorks', '命运之夜无限剑制');
add('TokyoGhoul', '东京食尸鬼');
add('東京喰種', '东京食尸鬼');
add('TokyoGhoulJack', '东京食尸鬼');
add('東京喰種JACK', '东京食尸鬼');
add('TokyoGhoulJACK', '东京食尸鬼');
add('TokyoRevengers', '东京复仇者');
add('東京リベンジャーズ', '东京复仇者');
add('OnePunchMan', '一拳超人');
add('ワンパンマン', '一拳超人');
add('MobPsycho100', '灵能百分百');
add('モブサイコ100', '灵能百分百');
add('ChainsawMan', '电锯人');
add('チェンソーマン', '电锯人');
add('Spy×Family', '间谍过家家');
add('SpyxFamily', '间谍过家家');
add('スパイファミリー', '间谍过家家');
add('BocchitheRock', '孤独摇滚');
add('ぼっちざろっく', '孤独摇滚');
add('OshiNoKo', '我推的孩子');
add('推しの子', '我推的孩子');
add('Frieren', '葬送的芙莉莲');
add('葬送のフリーレン', '葬送的芙莉莲');
add('SousouNoFrieren', '葬送的芙莉莲');
add('Gintama', '银魂');
add('銀魂', '银魂');
add('銀魂THEFINAL', '银魂');
add('GintamaTheFinal', '银魂');
add('GintamaTHEVERYFINAL', '银魂');
add('銀魂THEVERYFINAL', '银魂');
add('PsychoPass', '心理测量者');
add('サイコパス', '心理测量者');
add('CowboyBebop', '星际牛仔');
add('カウボーイビバップ', '星际牛仔');
add('NeonGenesisEvangelion', '新世纪福音战士');
add('新世紀エヴァンゲリオン', '新世纪福音战士');
add('Evangelion', '新世纪福音战士');
add('エヴァンゲリオン', '新世纪福音战士');
add('Monogatari', '物语系列');
add('化物語', '物语系列');
add('Bakemonogatari', '化物语');
add('AngelBeats', 'AngelBeats');
add('エンジェルビーツ', 'AngelBeats');
add('Clannad', 'CLANNAD');
add('クラナド', 'CLANNAD');
add('Toradora', '龙与虎');
add('とらドラ', '龙与虎');
add('Anohana', '未闻花名');
add('あの花', '未闻花名');
add('あの日見た花', '未闻花名');
add('YourLieinApril', '四月是你的谎言');
add('四月は君の嘘', '四月是你的谎言');
add('SilentVoice', '声之形');
add('聲の形', '声之形');
add('ASilentVoice', '声之形');
add('MadeinAbyss', '来自深渊');
add('メイドインアビス', '来自深渊');
add('VinlandSaga', '冰海战记');
add('ヴィンランドサガ', '冰海战记');
add('ThePromisedNeverland', '约定的梦幻岛');
add('約束のネバーランド', '约定的梦幻岛');
add('YakusokuNoNeverland', '约定的梦幻岛');
add('DrStone', '石纪元');
add('ドクターストーン', '石纪元');
add('FireForce', '炎炎消防队');
add('炎炎ノ消防隊', '炎炎消防队');
add('EnenNoShouboutai', '炎炎消防队');
add('BlackClover', '黑色五叶草');
add('ブラッククローバー', '黑色五叶草');
add('Haikyuu', '排球少年');
add('ハイキュー', '排球少年');
add('KurokoNoBasket', '黑子的篮球');
add('黒子のバスケ', '黑子的篮球');
add('BlueLock', '蓝色监狱');
add('ブルーロック', '蓝色监狱');
add('Aoashi', '青之芦苇');
add('アオアシ', '青之芦苇');
add('SoloLeveling', '我独自升级');
add('俺だけレベルアップな件', '我独自升级');
add('OreDakeLevelUpNaKen', '我独自升级');
add('Mashle', '物理魔法使马修');
add('マッシュル', '物理魔法使马修');
add('UndeadUnluck', '不死不幸');
add('アンデッドアンラック', '不死不幸');
add('HellParadise', '地狱乐');
add('地獄楽', '地狱乐');
add('Jigokuraku', '地狱乐');
add('LycorisRecoil', '莉可丽丝');
add('リコリスリコイル', '莉可丽丝');
add('SummerTimeRendering', '夏日重现');
add('サマータイムレンダ', '夏日重现');
add('KaguyaSamawaKokurasetai', '辉夜大小姐想让我告白');
add('かぐや様は告らせたい', '辉夜大小姐想让我告白');
add('LoveisWar', '辉夜大小姐想让我告白');
add('KomiCantCommunicate', '古见同学有交流障碍症');
add('古見さんはコミュ症です', '古见同学有交流障碍症');
add('MyDressUpDarling', '更衣人偶坠入爱河');
add('その着せ替え人形は恋をする', '更衣人偶坠入爱河');
add('SonoBisqueDoll', '更衣人偶坠入爱河');
add('Horimiya', '堀与宫村');
add('ホリミヤ', '堀与宫村');
add('RentAGirlfriend', '租借女友');
add('彼女お借りします', '租借女友');
add('KanojoOkarishimasu', '租借女友');
add('QuintessentialQuintuplets', '五等分的花嫁');
add('五等分の花嫁', '五等分的花嫁');
add('GotoubunNoHanayome', '五等分的花嫁');
add('GrandBlue', '碧蓝之海');
add('ぐらんぶる', '碧蓝之海');
add('Konosuba', '为美好的世界献上祝福');
add('ShieldHero', '盾之勇者成名录');
add('盾の勇者の成り上がり', '盾之勇者成名录');
add('TateNoYuusha', '盾之勇者成名录');
add('RisingoftheShieldHero', '盾之勇者成名录');
add('GoblinSlayer', '哥布林杀手');
add('ゴブリンスレイヤー', '哥布林杀手');
add('SlimeTaoshite300nen', '打了300年的史莱姆');
add('スライム倒して300年', '打了300年的史莱姆');
add('Tensura', '关于我转生变成史莱姆这档事');
add('Danmachi', '在地下城寻求邂逅是否搞错了什么');
add('ダンジョンに出会いを求めるのは間違っているだろうか', '在地下城寻求邂逅是否搞错了什么');
add('IsItWrongtoTrytoPickUpGirlsinaDungeon', '在地下城寻求邂逅是否搞错了什么');
add('ClassroomoftheElite', '欢迎来到实力至上主义的教室');
add('ようこそ実力至上主義の教室へ', '欢迎来到实力至上主义的教室');
add('YoukosoJitsuryoku', '欢迎来到实力至上主义的教室');
add('Oregairu', '我的青春恋爱物语果然有问题');
add('やはり俺の青春ラブコメはまちがっている', '我的青春恋爱物语果然有问题');
add('BunnyGirlSenpai', '青春猪头少年不会梦到兔女郎学姐');
add('青春ブタ野郎', '青春猪头少年不会梦到兔女郎学姐');
add('SeishunButaYarou', '青春猪头少年不会梦到兔女郎学姐');
add('86EightySix', '86-不存在的战区');
add('エイティシックス', '86-不存在的战区');
add('EightySix', '86-不存在的战区');
add('TengenToppaGurrenLagann', '天元突破红莲螺岩');
add('天元突破グレンラガン', '天元突破红莲螺岩');
add('GurrenLagann', '天元突破红莲螺岩');
add('JoJosBizarreAdventure', 'JOJO的奇妙冒险');
add('ジョジョの奇妙な冒険', 'JOJO的奇妙冒险');
add('JoJo', 'JOJO的奇妙冒险');
add('Berserk', '剑风传奇');
add('ベルセルク', '剑风传奇');
add('MonsterAnime', '怪物');
add('Monster', '怪物');
add('モンスター', '怪物');
add('Parasyte', '寄生兽');
add('寄生獣', '寄生兽');
add('Kiseijuu', '寄生兽');
add('ParasyteTheMaxim', '寄生兽');
add('Erased', '只有我不存在的城市');
add('僕だけがいない街', '只有我不存在的城市');
add('BokuDakeGaInaiMachi', '只有我不存在的城市');
add('ReLife', 'ReLIFE');
add('リライフ', 'ReLIFE');
add('AssassinationClassroom', '暗杀教室');
add('暗殺教室', '暗杀教室');
add('AnsatsuKyoushitsu', '暗杀教室');
add('FoodWars', '食戟之灵');
add('食戟のソーマ', '食戟之灵');
add('ShokugekinoSoma', '食戟之灵');
add('GTO', '麻辣教师GTO');
add('GreatTeacherOnizuka', '麻辣教师GTO');
add('SamuraiChamploo', '混沌武士');
add('サムライチャンプルー', '混沌武士');
add('Trigun', '枪神');
add('トライガン', '枪神');
add('FLCL', '特别的她');
add('フリクリ', '特别的她');
add('FoolyCooly', '特别的她');
add('Noragami', '野良神');
add('ノラガミ', '野良神');
add('AkameGaKill', '斩赤红之瞳');
add('アカメが斬る', '斩赤红之瞳');
add('KillLaKill', '斩服少女');
add('キルラキル', '斩服少女');
add('DarlingInTheFranxx', 'DARLINGintheFRANXX');
add('ダーリンインザフランキス', 'DARLINGintheFRANXX');
add('DarliFra', 'DARLINGintheFRANXX');
add('WonderEggPriority', '奇蛋物语');
add('ワンダーエッグプライオリティ', '奇蛋物语');
add('VivyFluoriteEyesSong', '薇薇-萤石眼之歌');
add('Vivy', '薇薇-萤石眼之歌');
add('OddTaxi', '奇巧计程车');
add('オッドタクシー', '奇巧计程车');
add('RankingofKings', '国王排名');
add('王様ランキング', '国王排名');
add('OusamaRanking', '国王排名');
add('ToYourEternity', '致不灭的你');
add('不滅のあなたへ', '致不灭的你');
add('FumetsuNoAnataE', '致不灭的你');
add('SonnyBoy', '漂流少年');
add('サニーボーイ', '漂流少年');
add('LinkClick', '时光代理人');
add('时光代理人', '时光代理人');
add('時光代理人', '时光代理人');
add('ShiguangDailiren', '时光代理人');
add('TheLegendofHei', '罗小黑战记');
add('羅小黒戦記', '罗小黑战记');
add('FogHillofFiveElements', '雾山五行');
add('霧山五行', '雾山五行');
add('ScissorsSeven', '刺客伍六七');
add('刺客伍六七', '刺客伍六七');
add('DailyLifeofImmortalKing', '仙王的日常生活');
add('仙王的日常生活', '仙王的日常生活');
add('TheKingsAvatar', '全职高手');
add('全職高手', '全职高手');
add('QuanZhiGaoShou', '全职高手');
add('MoDaoZuShi', '魔道祖师');
add('魔道祖师', '魔道祖师');
add('魔道祖師', '魔道祖师');
add('GrandmasterofDemonicCultivation', '魔道祖师');
add('HeavenOfficialsBlessing', '天官赐福');
add('天官赐福', '天官赐福');
add('天官賜福', '天官赐福');
add('TianGuanCiFu', '天官赐福');
add('BalanceUnlimited', '富豪刑事');
add('富豪刑事', '富豪刑事');
add('FugouKeiji', '富豪刑事');
add('SK8TheInfinity', '无限滑板');
add('無限滑板', '无限滑板');
add('SK∞', '无限滑板');
add('SK8', '无限滑板');
add('Given', 'GIVEN');
add('ギヴン', 'GIVEN');
add('YurionIce', '冰上的尤里');
add('ユーリオンアイス', '冰上的尤里');
add('YuriOnIce', '冰上的尤里');
add('Free', 'Free!男子游泳部');
add('フリー', 'Free!男子游泳部');
add('BananaFish', 'BANANAFISH');
add('バナナフィッシュ', 'BANANAFISH');
add('91Days', '91天');
add('Baccano', '永生之酒');
add('バッカーノ', '永生之酒');
add('Durarara', '无头骑士异闻录');
add('デュラララ', '无头骑士异闻录');
add('BlackLagoon', '黑礁');
add('ブラックラグーン', '黑礁');
add('Jormungand', '军火女王');
add('ヨルムンガンド', '军火女王');
add('Gangsta', 'GANGSTA');
add('ギャングスタ', 'GANGSTA');
add('DarkerThanBlack', '黑之契约者');
add('DARKERTHANBLACK', '黑之契约者');
add('PhantomRequiemforthePhantom', '幻灵镇魂曲');

// ======================= 2025 - 2026 热门在播 =======================
add('Dandadan', '当哒当');
add('ダンダダン', '当哒当');
add('SakamotoDays', '坂本日常');
add('サカモトデイズ', '坂本日常');
add('KaijuNo8', '怪兽8号');
add('怪獣8号', '怪兽8号');
add('KaijuNo.8', '怪兽8号');
add('WindBreaker', '防风少年');
add('ウィンドブレイカー', '防风少年');
add('TheFable', '寓言杀手');
add('ザファブル', '寓言杀手');
add('GoGoLoserRanger', '战队大失格');
add('戦隊大失格', '战队大失格');
add('SentaiDaishikkaku', '战队大失格');
add('ABridesStory', '少女新娘物语');
add('乙嫁語り', '少女新娘物语');
add('Otoyomegatari', '少女新娘物语');
add('Lazarus', 'LAZARUS');
add('ラザロ', 'LAZARUS');
add('ShuumatsuTrainDokoheiku', '终末列车去哪里');
add('終末トレインどこへいく', '终末列车去哪里');
add('TrainToTheEndOfTheWorld', '终末列车去哪里');
add('Gachiakuta', '废渊战鬼');
add('ガチアクタ', '废渊战鬼');
add('Kagurabachi', '神乐钵');
add('カグラバチ', '神乐钵');
add('KowloonGenericRomance', '九龙大众浪漫');
add('九龍ジェネリックロマンス', '九龙大众浪漫');
add('Kenshin', '浪客剑心');
add('るろうに剣心', '浪客剑心');
add('RurouniKenshin', '浪客剑心');
add('Zomb100', '僵尸百分百');
add('ゾン100', '僵尸百分百');
add('Zom100', '僵尸百分百');
add('Zombie100', '僵尸百分百');

// ======================= 青春猪头少年系列 =======================
add('SeishunButaYarouwaBunnyGirlSenpainoYumewoMinai', '青春猪头少年不会梦到兔女郎学姐');
add('青春ブタ野郎はバニーガール先輩の夢を見ない', '青春猪头少年不会梦到兔女郎学姐');
add('RascalDoesNotDreamofBunnyGirlSenpai', '青春猪头少年不会梦到兔女郎学姐');
add('SeishunButaYarouwaYumemiruShoujonoYumewoMinai', '青春猪头少年不会梦到怀梦美少女');
add('青春ブタ野郎はゆめみる少女の夢を見ない', '青春猪头少年不会梦到怀梦美少女');
add('RascalDoesNotDreamofaDreamingGirl', '青春猪头少年不会梦到怀梦美少女');
add('SeishunButaYarouwaYumeMiruShoujoNoYumeWoMinai', '青春猪头少年不会梦到怀梦美少女');

// ======================= 水果篮子 =======================
add('FruitsBasket', '水果篮子');
add('フルーツバスケット', '水果篮子');

// ======================= 其他常见番剧 =======================
add('Dandadan', '胆大党');
add('ダンダダン', '胆大党');
add('KusuriyaNoHitorigoto', '药屋少女的呢喃');
add('薬屋のひとりごと', '药屋少女的呢喃');
add('TheApothecaryDiaries', '药屋少女的呢喃');
add('SousouNoFrieren', '葬送的芙莉莲');
add('FrierenBeyondJourneysEnd', '葬送的芙莉莲');
add('DungeonMeshi', '迷宫饭');
add('ダンジョン飯', '迷宫饭');
add('DeliciousinDungeon', '迷宫饭');

// ======================= 2026年补充 =======================
add('SaikyouNoOusamaNidomeNoJinsei', '最强王者的第二人生');
add('最強の王様、二度目の人生は何をする', '最强王者的第二人生');
add('SaikyouNoOusama', '最强王者的第二人生');
add('TheBeginningAfterTheEnd', '最强王者的第二人生');
add('IsekaiNonbinNouka', '异世界悠闲农家');
add('異世界のんびり農家', '异世界悠闲农家');
add('IsekaiNonbiriNouka', '异世界悠闲农家');
add('OtakuNiYasashiiGalWaInai', '没有温柔对待阿宅的辣妹');
add('オタクに優しいギャルはいない', '没有温柔对待阿宅的辣妹');
add('GalsCantBeKindToOtaku', '没有温柔对待阿宅的辣妹');
add('Dorohedoro', '异兽魔都');
add('ドロヘドロ', '异兽魔都');

// ======================= 2026年春季新番补充 =======================
add('OokiiOnnanokoWaSukiDesuka', '这样高大的女孩子你喜欢吗？');
add('JidouHanbaikiNiUmarekawattaOreWaMeikyuuWoSamayou', '转生成自动贩卖机的我今天也在迷宫徘徊');
add('自動販売機に生まれ変わった俺は迷宮を彷徨う', '转生成自动贩卖机的我今天也在迷宫徘徊');
add('RebornAsAVendingMachine', '转生成自动贩卖机的我今天也在迷宫徘徊');
add('KanojoOkarishimasu5thSeason', '租借女友 第五季');
add('彼女お借りします5thSeason', '租借女友 第五季');
add('RentAGirlfriend5', '租借女友 第五季');
add('SaikyouNoOusamaNidomeNoJinsei2ndSeason', '最强王者的第二人生 第二季');
add('最強の王様二度目の人生は何をする2ndSeason', '最强王者的第二人生 第二季');
add('InjuuTanchi', '淫狱团地');
add('淫獣団地', '淫狱团地');
add('大きい女の子は好きですか', '这样高大的女孩子你喜欢吗？');
add('DoYouLikeBigGirls', '这样高大的女孩子你喜欢吗？');
add('ClassDe2BanmeNiKawaiiOnnanokoToTomodachiNiNatta', '我和班上第二可爱的女生成为了朋友');
add('クラスで2番目に可愛い女の子と友だちになった', '我和班上第二可爱的女生成为了朋友');
add('AishiteruGameWoOwarasetai', '想结束这场「我爱你」的游戏');
add('愛してるゲームを終わらせたい', '想结束这场「我爱你」的游戏');
add('HigekiNoGenshinTonaruSaikyouGedouRasBossJoouHaTamenoTameNiTsukushimasu', '成为悲剧元凶的最强异端，最后头目女王为了人民牺牲奉献');
add('悲劇の元凶となる最強外道ラスボス女王は民の為に尽くします', '成为悲剧元凶的最强异端，最后头目女王为了人民牺牲奉献');
add('Lastame', '成为悲剧元凶的最强异端，最后头目女王为了人民牺牲奉献');
add('GansoBandorichan', '元祖！BanG Dream酱');
add('元祖バンドリちゃん', '元祖！BanG Dream酱');
add('GANSOBanGDreamChan', '元祖！BanG Dream酱');
add('KirioFanclub', '雾尾粉丝后援会');
add('霧尾ファンクラブ', '雾尾粉丝后援会');
add('KirioFanClub', '雾尾粉丝后援会');
add('MegamiIsekaiTenseiNaniNiNaritaiDesukaOreYuushaNoRokkotsude', '女神「异世界转生想成为什么」我「勇者的肋骨」');
add('女神異世界転生何になりたいですか俺勇者の肋骨で', '女神「异世界转生想成为什么」我「勇者的肋骨」');
add('MegamiIsekaiTensei', '女神「异世界转生想成为什么」我「勇者的肋骨」');
add('Mofusand', '猫福珊迪');
add('YowaYowaSensei', '弱弱老师');
add('よわよわ先生', '弱弱老师');
add('WeakTeacher', '弱弱老师');
add('AkaneBanashi', '朱音落语');
add('あかね噺', '朱音落语');
add('IsekaiNonbiriNouka2', '异世界悠闲农家2');
add('異世界のんびり農家2', '异世界悠闲农家2');
add('TenseiShitaraSlimeDattaKen4thSeason', '关于我转生变成史莱姆这档事 第4季');
add('転生したらスライムだった件第4期', '关于我转生变成史莱姆这档事 第4季');
add('ReZeroKaraHajimeruIsekaiSeikatsu4thSeason', '从零开始的异世界生活 第四季');
add('Reゼロから始める異世界生活4thSeason', '从零开始的异世界生活 第四季');
add('TsueToTsurugiNoWistoria2', '杖与剑的魔剑谭 第2季');
add('杖と剣のウィストリア第2期', '杖与剑的魔剑谭 第2季');
add('YoukosoJitsuryokuShijouShugiNoKyoushitsuE', '欢迎来到实力至上主义的教室');
add('ようこそ実力至上主義の教室へ', '欢迎来到实力至上主义的教室');
add('OtonariNoTenshiSamaNiItsunomanikaDameNingenNiSareteitaKen', '关于我在无意间被隔壁的天使变成废柴这件事');
add('お隣の天使様にいつの間にか駄目人間にされていた件', '关于我在无意间被隔壁的天使变成废柴这件事');
add('TongariBoushiNoAtelier', '魔法帽的工作室');
add('とんがり帽子のアトリエ', '魔法帽的工作室');
add('WitchHatAtelier', '魔法帽的工作室');
add('YozakuraSanChiNoDaisakusen', '夜樱家大作战');
add('夜桜さんちの大作戦', '夜樱家大作战');
add('MissionYozakuraFamily', '夜樱家大作战');
add('KanojoOkarishimasu', '出租女友');
add('彼女お借りします', '出租女友');
add('RentAGirlfriend', '出租女友');
add('KuronekoToMajoNoKyoushitsu', '黑猫与魔女的教室');
add('黒猫と魔女の教室', '黑猫与魔女的教室');
add('KamiueInaBotan', '上伊那牡丹，醉姿如百合');
add('上伊那ぼたん酔へる姿は百合の花', '上伊那牡丹，醉姿如百合');
add('HaiwaraKunNoTsuyokuteSeishunNewGame', '灰原同学重返过去，开启所向无敌的第二轮青春游戏');
add('灰原くんの強くて青春ニューゲーム', '灰原同学重返过去，开启所向无敌的第二轮青春游戏');
add('HonzukiNoGekokujou', '小书痴的下剋上');
add('本好きの下剋上', '小书痴的下剋上');
add('AscendanceOfABookworm', '小书痴的下剋上');
add('MeidoSanWaTaberuDake', '女仆小姐的贪吃日常');
add('メイドさんは食べるだけ', '女仆小姐的贪吃日常');
add('MaidSanWaTaberuDake', '女仆小姐的贪吃日常');
add('NigashitaSakanaWaOokikattaGaTsuriagetaSakanaGaOokisugitaKen', '溜掉的大鱼比不上自己钓到的鱼');
add('逃がした魚は大きかったが釣りあげた魚が大きすぎた件', '溜掉的大鱼比不上自己钓到的鱼');
add('ReincarnationNoHanabira', '轮回的花瓣');
add('リィンカーネーションの花弁', '轮回的花瓣');
add('SaikyouNoShokugaiHaYuushaDemoKenjaDemoNakuKanteishiRashiiDesuYo', '最强的职业不是勇者也不是贤者好像是鉴定士（暂）的样子？');
add('最強の職業は勇者でも賢者でもなく鑑定士らしいですよ', '最强的职业不是勇者也不是贤者好像是鉴定士（暂）的样子？');
add('MahouNoShimaiRuruttoRirii', '魔法姊妹露露特莉莉');
add('魔法の姉妹ルルットリリィ', '魔法姊妹露露特莉莉');
add('MarriageToxin', '婚姻剧毒');
add('マリッジトキシン', '婚姻剧毒');
add('ReplicaDatteKoiWoSuru', '复制品的我也会谈恋爱。');
add('レプリカだって恋をする', '复制品的我也会谈恋爱。');
add('ReplicaDating', '复制品的我也会谈恋爱。');
add('KooriNoJouheki', '冰之城墙');
add('氷の城壁', '冰之城墙');
add('IceWall', '冰之城墙');
add('AwashimaHyakkei', '淡岛百景');
add('淡島百景', '淡岛百景');
add('JishouAkuyakuReijouNaKonyakushaNoKansatsukiroku', '自称恶役千金的未婚妻观察纪录。');
add('自称悪役令嬢な婚約者の観察記録', '自称恶役千金的未婚妻观察纪录。');
add('SnowballEarth', '冻结地球');
add('スノウボールアース', '冻结地球');
add('NihonSangoku', '日本三国');
add('日本三国', '日本三国');
add('MatsurikaChanNoKoukandoWaHoukaiShichau', '茉莉花酱的好感度正在崩坏');
add('茉莉花醬の好感度は崩壊しちゃう', '茉莉花酱的好感度正在崩坏');
add('MatsurikaChanNoKoukandoWaHoukaiShichauNo', '茉莉花酱的好感度正在崩坏');
add('YuushaNoKuzu', '勇者之渣');
add('勇者の屑', '勇者之渣');
add('MataKorosareteShimattaNoDesuNeTanteiSama', '你又被杀了呢，侦探大人');
add('また殺されてしまったのですね探偵様', '你又被杀了呢，侦探大人');
add('ShunkashuutouDaiKoushaHaruNoMai', '春夏秋冬代行者 春之舞');
add('春夏秋冬代行者春の舞', '春夏秋冬代行者 春之舞');
add('NiwaToriFighter', 'ROOSTER FIGHTER 怒火鸡头');
add('ニワトリファイター', 'ROOSTER FIGHTER 怒火鸡头');
add('RoosterFighter', 'ROOSTER FIGHTER 怒火鸡头');
add('OtakuNiYasashiiGalWaInai2', '哪里有温柔对待阿宅的辣妹！？');
add('オタクに優しいギャルはいない', '哪里有温柔对待阿宅的辣妹！？');
add('KananSamaWaAkumadeChoroi', '容易对付的恶魔大人');
add('カナン様はあくまでチョロい', '容易对付的恶魔大人');
add('HimeKishiWaBanZokuNoYome', '女骑士成为蛮族新娘');
add('姫騎士は蛮族の嫁', '女骑士成为蛮族新娘');
add('PrincessKnightIsTheBrideOfTheBarbarians', '女骑士成为蛮族新娘');
// OIAPI 直接用原生标题「一畳間まんきつ暮らし」能返回正确中文「一叠间漫画咖啡屋生活」
// 不需要映射，避免覆盖正确翻译
add('NeedyGirlOverdose', '主播女孩重度依赖');
add('YomichiNoTsugai', '黄泉双使');
add('黄泉のツガイ', '黄泉双使');
add('GhostConcert', 'GHOST CONCERT');
add('ゴーストコンサート', 'GHOST CONCERT');
add('DrStone', '新石纪');
add('KuzumaUtauIe', '庫茲馬唱歌的家');
add('HidariteNoEren', '左撇子艾倫');
add('SatsuhakuSeishun', '杀手青春');
add('WatashiGaKaetteKitaKareGaMataJamaShitekuru', '我回来了，他又来打扰了！');
add('KouhoKikan', '归還');
add('KogarashiFuuKiinToMiniSkirtJK', '木头风纪委员和迷你裙JK');
add('GanbareNakamuraKun', '加油! 中村同学');
add('Mao', 'MAO摩绪');
add('MairimashitaIrumaKun', '入间同学入魔了');
add('DiamondNoAce', '钻石王牌');
add('LiarGame', 'LIAR GAME');
add('KamiNoShizuku', '神之水滴');
add('NegaiNoIdolPrincess', '愿望的偶像公主');
add('CandyCaries', 'Candy Caries');
add('KozaruSanNoOdekake', '小鲨鲨出门去');
add('Kumarba', 'Kumarba');
add('MouseNoChichi', '鼠小弟的小背心');
add('Rilakkuma', '松弛熊');

// ======================= 2026年春季新番 — 全面覆盖（确保日历不漏番） =======================
// 冰之城墙
add('KooriNoJouheki', '冰之城墙');
add('氷の城壁', '冰之城墙');
add('IceRampart', '冰之城墙');
// 春夏秋冬代行者 春之舞
add('ShunkashuutouDaiKoushaHaruNoMai', '春夏秋冬代行者 春之舞');
add('春夏秋冬代行者春の舞', '春夏秋冬代行者 春之舞');
add('TheAgentsOfTheFourSeasonsSpringDance', '春夏秋冬代行者 春之舞');
// 大贤者里德尔的时间逆行
add('DaikenshaRiddleNoJikanGyakkou', '大贤者里德尔的时间逆行');
add('大賢者リドルの時間逆行', '大贤者里德尔的时间逆行');
add('SageRiddlesTimeReversal', '大贤者里德尔的时间逆行');
add('DaikenshaRiddlenoJikanGyakkou', '大贤者里德尔的时间逆行');
// 魔物喰らいの冒険者
add('MamonoKuraiNoBoukensha', '食魔的冒险者');
add('魔物喰らいの冒険者', '食魔的冒险者');
add('MonsterEatingAdventurer', '食魔的冒险者');
// 神之庭院楠木邸
add('KaminoNiwatsukiKusunokitei', '神之庭院楠木邸');
add('神の庭付き楠木邸', '神之庭院楠木邸');
add('KaminoNiwatsukiKusunokiTei', '神之庭院楠木邸');
// 我回家了，打扰了
add('TadaimaOjamaSaremasu', '我回家了，打扰了');
add('ただいま、おじゃまされます', '我回家了，打扰了');
add('ImHomeSorryforIntruding', '我回家了，打扰了');
add('TadaimaOjamashimasu', '我回家了，打扰了');
// Kill Blue / 深蓝暗杀
add('KillBlue', '深蓝暗杀');
add('KillBlueキルアオ', '深蓝暗杀');
add('キルアオ', '深蓝暗杀');
add('Kiruao', '深蓝暗杀');
// Dr.STONE SCIENCE FUTURE (第3季度)
add('DrStoneScienceFuture', '石纪元 科学未来');
add('DrSTONESCIENCEFUTURE', '石纪元 科学未来');
add('Dr.STONESCIENCEFUTURE', '石纪元 科学未来');
// 想结束这场「我爱你」的游戏
add('AishiteruGameWoOwarasetai', '想结束这场「我爱你」的游戏');
add('愛してるゲームを終わらせたい', '想结束这场「我爱你」的游戏');
add('IWanttoEndtheILoveYouGame', '想结束这场「我爱你」的游戏');
add('IWanttoEndTheILoveYouGame', '想结束这场「我爱你」的游戏');
// 茉莉花酱的好感度正在崩坏
add('MatsurikaChanNoKoukandoWaHoukaiShichau', '茉莉花酱的好感度正在崩坏');
add('MatsurikaChanNoKoukandoWaBukkowareteiru', '茉莉花酱的好感度正在崩坏');
add('MarikaChansAffectionRatingIsBroken', '茉莉花酱的好感度正在崩坏');
// 左撇子艾伦
add('HidariteNoEren', '左撇子艾伦');
add('左ききのエレン', '左撇子艾伦');
add('LeftHandedEllen', '左撇子艾伦');
add('HidarikinoEren', '左撇子艾伦');
// 班级第二可爱
add('ClassDe2BanmeNiKawaiiOnnanokoToTomodachiNiNatta', '我和班上第二可爱的女生成为了朋友');
add('クラスで2番目に可愛い女の子と友だちになった', '我和班上第二可爱的女生成为了朋友');
add('IBecameFriendswiththeSecondCutestGirlinClass', '我和班上第二可爱的女生成为了朋友');
// 上伊那牡丹
add('KamiueInaBotan', '上伊那牡丹，醉姿如百合');
add('上伊那ぼたん', '上伊那牡丹，醉姿如百合');
add('KamieuInaBotanYooHeruSugatawaYurinoHana', '上伊那牡丹，醉姿如百合');
add('上伊那ぼたん酔へる姿は百合の花', '上伊那牡丹，醉姿如百合');
// 最强的职业不是勇者也不是贤者
add('SaikyouNoShokugaiHaYuushaDemoKenjaDemoNakuKanteishiRashiiDesuYo', '最强的职业不是勇者也不是贤者好像是鉴定士（暂）的样子？');
add('最強の職業は勇者でも賢者でもなく鑑定士らしいですよ', '最强的职业不是勇者也不是贤者好像是鉴定士（暂）的样子？');
// 女神宿舍的宿管君 第二季 → should map to 女神宿舍的宿管君 (no season 2 in reality)
add('MegamiRyouNoRyouboKun2ndSeason', '女神宿舍的宿管君');
add('女神寮の寮母くん2ndSeason', '女神宿舍的宿管君');
// 女神「异世界转生想成为什么」我「勇者的肋骨」
add('MegamiIsekaiTenseiNaniNaritaiDesukaOreYuushaNoRokkotsuDe', '女神「异世界转生想成为什么」我「勇者的肋骨」');
add('女神異世界転生何になりたいですか俺勇者の肋骨で', '女神「异世界转生想成为什么」我「勇者的肋骨」');
// 成为悲剧元凶的最强异端
add('HigekiNoGenshinTonaruSaikyouGedouLastBossJoouWaTamiNoTameNiTsukushimasu', '成为悲剧元凶的最强异端，最后头目女王为了人民牺牲奉献');
add('悲劇の元凶となる最強外道ラスボス女王は民の為に尽くします', '成为悲剧元凶的最强异端，最后头目女王为了人民牺牲奉献');
// 蜡笔小新
add('CrayonShinchan', '蜡笔小新');
add('クレヨンしんちゃん', '蜡笔小新');
add('KureyonShinchan', '蜡笔小新');
// 小书痴的下克上 领主的养女
add('HonzukiNoGekokujouShishoNiNaruTameNiwaShudanWoErandeiraremasenKanketsuhen', '小书痴的下剋上 领主的养女');
add('本好きの下剋上司書になるためには手段を選んでいられません完結編', '小书痴的下剋上 领主的养女');
add('AscendanceofaBookwormFinalArc', '小书痴的下剋上 领主的养女');
// 物语系列 新房版
add('MonogatariSeriesOffSeason', '物语系列 外传季');
add('MonogatariSeriesMonsterSeason', '物语系列 怪物季');
// 钻石王牌 actII Second Season
add('DaiyaNoAActIISecondSeason', '钻石王牌 actII 第二季');
add('ダイヤのAactIISecondSeason', '钻石王牌 actII 第二季');
add('AceofDiamondActIISecondSeason', '钻石王牌 actII 第二季');
add('AceoftheDiamondActIISecondSeason', '钻石王牌 actII 第二季');
// 异世界悠闲农家 2
add('IsekaiNonbiriNouka2ndSeason', '异世界悠闲农家 第二季');
add('異世界のんびり農家2ndSeason', '异世界悠闲农家 第二季');
add('FarmingLifeinAnotherWorldSeason2', '异世界悠闲农家 第二季');
// 最强王者的第二人生
add('TheBeginningAfterTheEnd', '最强王者的第二人生');
add('SaikyouNoOusamaNidomeNoJinsei', '最强王者的第二人生');
// 灰原同学
add('HaiwaraKunNoTsuyokuteSeishunNewGame', '灰原同学重返过去，开启所向无敌的第二轮青春游戏');
add('灰原くんの強くて青春ニューゲーム', '灰原同学重返过去，开启所向无敌的第二轮青春游戏');
add('HaibaraKunsStrongandYouthfulNewGame', '灰原同学重返过去，开启所向无敌的第二轮青春游戏');
// 魔法帽的工作室
add('TongariBoushiNoAtelier', '魔法帽的工作室');
add('とんがり帽子のアトリエ', '魔法帽的工作室');
add('WitchHatAtelier', '魔法帽的工作室');
// 元祖！BanG Dream酱
add('GansoBandorichan', '元祖！BanG Dream酱');
add('元祖バンドリちゃん', '元祖！BanG Dream酱');
add('GANSOBanGDreamChan', '元祖！BanG Dream酱');
// 淫狱团地
add('InjuuDanchi', '淫狱团地');
add('淫獣団地', '淫狱团地');
// 弱弱老师
add('YowaYowaSensei', '弱弱老师');
add('よわよわ先生', '弱弱老师');
add('WeakTeacher', '弱弱老师');
// 猫福珊迪
add('Mofusand', '猫福珊迪');
// 朱音落语
add('AkaneBanashi', '朱音落语');
add('あかね噺', '朱音落语');
// 入间同学入魔了 第4季
add('MairimashitaIrumaKun4thSeason', '入间同学入魔了 第四季');
add('魔入りました入間くん第4シリーズ', '入间同学入魔了 第四季');
add('WelcometoDemonSchoolIrumaKunSeason4', '入间同学入魔了 第四季');
// 夜樱家大作战
add('YozakuraSanChiNoDaisakusen', '夜樱家大作战');
add('夜桜さんちの大作戦', '夜樱家大作战');
add('MissionYozakuraFamily', '夜樱家大作战');
// 容易对付的恶魔大人
add('KananSamaWaAkumadeChoroi', '容易对付的恶魔大人');
add('カナン様はあくまでチョロい', '容易对付的恶魔大人');
add('CanaanSamaIsTotallyEasy', '容易对付的恶魔大人');
// 女骑士成为蛮族新娘
add('HimeKishiWaBanZokuNoYome', '女骑士成为蛮族新娘');
add('姫騎士は蛮族の嫁', '女骑士成为蛮族新娘');
add('PrincessKnightIsTheBrideOfTheBarbarians', '女骑士成为蛮族新娘');
// 库兹马唱歌的家
add('KuzumaUtauIe', '库兹马唱歌的家');
// 幽灵音乐会
add('GhostConcert', 'GHOST CONCERT');
add('ゴーストコンサート', 'GHOST CONCERT');
// 哆啦A梦（补充）
add('doraemon', '哆啦A梦');
// 宝可梦地平线（补充）
add('PocketMonsters2023', '宝可梦 地平线');
add('PokemonHorizons', '宝可梦 地平线');
add('PokémonHorizons', '宝可梦 地平线');
add('PocketMonstersLikoAndRoysAdventure', '宝可梦 地平线');
// 松驰熊 / 轻松小熊
add('RilakkumaToKaoruSan', '轻松小熊');
add('リラックマとかおるさん', '轻松小熊');
// 黑猫与魔女的教室
add('KuronekoToMajoNoKyoushitsu', '黑猫与魔女的教室');
add('黒猫と魔女の教室', '黑猫与魔女的教室');
add('BlackCatandWitchsClassroom', '黑猫与魔女的教室');
// Dandadan / 胆大党 (fix duplicate)
add('Dandadan', '胆大党');
add('ダンダダン', '胆大党');
add('DanDaDan', '胆大党');
// 药屋少女的呢喃 第二季
add('KusuriyaNoHitorigoto2ndSeason', '药屋少女的呢喃 第二季');
add('薬屋のひとりごと2ndSeason', '药屋少女的呢喃 第二季');
add('TheApothecaryDiariesSeason2', '药屋少女的呢喃 第二季');
// 防风少年 (补充)
add('WindBreakerSeason2', '防风少年 第二季');
add('ウィンドブレイカーSeason2', '防风少年 第二季');
// 坂本日常 (补充)
add('SakamotoDays2ndSeason', '坂本日常 第二季');
add('サカモトデイズ2ndSeason', '坂本日常 第二季');

// ======================= 第二层扩展：更多标题归一化映射 =======================
// 2026 春季新番补充（覆盖更多拼写变体）
add('WitchHatAtelier', '魔法帽的工作室');
add('Witch_Hat_Atelier', '魔法帽的工作室');
add('WandAndSword', '杖与剑的魔剑谭');
add('Wistoria', '杖与剑的魔剑谭');
add('WistoriaWandandSword', '杖与剑的魔剑谭');
add('TsueToTsurugiNoWistoria', '杖与剑的魔剑谭');
add('ClassroomOfTheElite4thSeason', '欢迎来到实力至上主义的教室 第四季');
add('ClassroomOfTheEliteSeason4', '欢迎来到实力至上主义的教室 第四季');
add('YoukosoJitsuryokuShijouShugiNoKyoushitsuE4thSeason', '欢迎来到实力至上主义的教室 第四季');
add('ReZeroSeason4', '从零开始的异世界生活 第四季');
add('ReZero4thSeason', '从零开始的异世界生活 第四季');
add('ReZeroStartingLifeInAnotherWorldSeason4', '从零开始的异世界生活 第四季');
add('SlimeSeason4', '关于我转生变成史莱姆这档事 第四季');
add('TensuraSeason4', '关于我转生变成史莱姆这档事 第四季');
add('TenseiShitaraSlimeDattaKen4thSeason', '关于我转生变成史莱姆这档事 第四季');
add('DaemonsOfTheShadowRealm', '黄泉使者');
add('YomiNoTsugai', '黄泉使者');
add('SecondCutestGirl', '我和班上第二可爱的女生成为了朋友');
add('ClassDe2BanmeNiKawaii', '我和班上第二可爱的女生成为了朋友');
add('GodsGarden', '神之庭院楠木邸');
add('KusunokisGardenOfGods', '神之庭院楠木邸');
add('MyRibdiculousReincarnation', '女神「异世界转生想成为什么」我「勇者的肋骨」');
add('CheongchunBlossomUriuiBom', '青春选择题');
add('청춘블라썸우리의봄', '青春选择题');
add('ReplicaCanFallInLove', '复制品也要谈恋爱');
add('DigimonBeatbreak', '数码宝贝 BEATBREAK');
add('ScumOfTheBrave', '勇者的渣滓');
add('KilledAgainMrDetective', '又被杀了啊，侦探大人');
add('AlwaysACatch', '逃掉的鱼很大但钓上来的鱼太大了');
add('AngelNextDoor2ndSeason', '关于我在无意间被隔壁的天使变成废柴这件事 第二季');
add('OtonariNoTenshiSama2ndSeason', '关于我在无意间被隔壁的天使变成废柴这件事 第二季');
add('KanojoOkarishimasu5thSeason', '租借女友 第五期');
add('RentAGirlfriend5thSeason', '租借女友 第五期');
add('EminenceInShadowSeason3', '想要成为影之实力者 第三季');
add('KageNoJitsuryokushaNiNaritakuteSeason3', '想要成为影之实力者 第三季');
add('FireForceSeason3', '炎炎消防队 叁之章');
add('EnenNoShouboutaiSanNoShou', '炎炎消防队 叁之章');
add('RockIsALadyModesty', '摇滚乃是淑女的爱好');
add('WitchWatch', 'Witch Watch 魔女与使魔');
add('WitchWatchAnime', 'Witch Watch 魔女与使魔');
add('PureFriendship', '男女之间存在纯友情吗？（不，不存在！）');
add('ShiunjiFamily', '紫云寺家的兄弟姐妹');
add('AxeBear', '持斧的熊');
add('Yatagarasu', '八咫乌');
add('ChroniclesOfAnAristocrat', '神统记');
add('FrozenScarlet', '冻僵的斯卡洛特');
add('VillainousDaughter', '恶食千金与狂血公爵');
add('PaperPlane', '折纸飞机的宣战');
add('OsomatsuSan4thSeason', '阿松 第四季');
add('DemonHumanLanternShow', '鬼人幻灯抄');
add('GrendizerU', '金刚战神U');
add('SilverWingSuperman', '银翼超人');
add('SkipAndLoafer2ndSeason', '跃动青春 第二季');
add('BlackButlerGreenWitch', '黑执事 绿之魔女篇');
add('KuroshitsujiMidoriNoMajoHen', '黑执事 绿之魔女篇');
add('ATeam', 'A级战队');
add('DangerousInMyHeartSeason2', '我心里危险的东西 第二季');
add('DanMachiSeason5', '在地下城寻求邂逅是否搞错了什么 第五季');
add('IsItWrongToPickUpGirlsInADungeon5', '在地下城寻求邂逅是否搞错了什么 第五季');
add('WanderingWitchSeason2', '魔女之旅 第二季');
add('MajoNoTabitabi2ndSeason', '魔女之旅 第二季');
add('DragonBallDaima', '龙珠大魔');
add('MushokuTenseiSeason2Part2', '无职转生 第二季 Part.2');
add('MushokuTensei2ndSeasonPart2', '无职转生 第二季 Part.2');
add('JoblessReincarnationSeason2Part2', '无职转生 第二季 Part.2');

// ======================= 已完结经典番剧（搜索用，不会污染日历/今日更新） =======================
add('DateALiveIV', '约会大作战 第四季');
add('DateALiveSeason4', '约会大作战 第四季');
add('デート・ア・ライブIV', '约会大作战 第四季');
add('ArifuretaShokugyouDeSekaiSaikyou2ndSeason', '平凡职业造就世界最强 第二季');
add('ありふれた職業で世界最強2ndSeason', '平凡职业造就世界最强 第二季');
add('Arifureta2', '平凡职业造就世界最强 第二季');
add('MegamiRyouNoRyouboKun', '女神宿舍的宿管君');
add('女神寮の寮母くん', '女神宿舍的宿管君');

// ======================= 辅助函数 =======================
function normalize(k) {
  return k.toLowerCase()
    .replace(/\s+/g, '')                    // 去空格
    .replace(/[×ｘx]/g, 'x')                 // 乘号→x
    .replace(/[\(\)\[\]（）【】:：\-–—\.\,\!\?]+/g, '')  // 去标点
    // Normalize season patterns to just the digit so "Season 3" ≠ "Season 2"
    // "1stSeason"/"2ndSeason"/"3rdSeason"/"4thSeason" → "1"/"2"/"3"/"4"
    .replace(/(\d+)(?:st|nd|rd|th)season/i, '$1')
    // "Season3"/"season3" → "3" (keeps the number to distinguish seasons)
    .replace(/season(\d+)/i, '$1')
    // 中文序数 "第3季"/"3期" → "3"
    .replace(/第?\s*(\d+)\s*[期季]/g, '$1');
    // NOTE: Do NOT strip trailing Roman numerals (IV, V, VI, etc.)
    // They are essential for distinguishing different seasons (e.g. "Date A Live IV" ≠ "Date A Live V")
}

function findChinese(romaji, english, native, fallback) {
  const keys = [romaji, english, native, fallback].filter(Boolean);
  for (const k of keys) {
    let norm = normalize(k);
    if (TITLE_MAP.has(norm)) return TITLE_MAP.get(norm);
    // 再尝试去掉年份
    const noYear = norm.replace(/\d{4}/g, '');
    if (noYear !== norm && TITLE_MAP.has(noYear)) return TITLE_MAP.get(noYear);
    // 渐进式缩短
    const shorter = norm.replace(/[～~!@#$%^&*+=|\\/;'"]/g, '');
    if (shorter !== norm && TITLE_MAP.has(shorter)) return TITLE_MAP.get(shorter);
  }

  // Fallback: substring matching for long titles (e.g. Jikan full title vs. abbreviated key)
  // CRITICAL: Use proportion-based matching to prevent wrong season matches.
  // E.g. "datealive" (9 chars) should NOT match "datealiveiv" (11 chars, different season).
  // Also prevents short keys like "monster" from matching long unrelated titles.
  for (const k of keys) {
    let norm = normalize(k);
    if (norm.length < 6) continue;
    for (const [mapKey, chinese] of TITLE_MAP) {
      // Direction 1: norm contains mapKey (incoming title contains known key)
      if (mapKey.length >= 6 && norm.includes(mapKey) && mapKey.length / norm.length >= 0.8) return chinese;
      // Direction 2: mapKey contains norm (known key contains incoming title)
      if (mapKey.length >= 6 && mapKey.includes(norm) && norm.length / mapKey.length >= 0.8) return chinese;
    }
  }

  return null;
}

// 兼容旧代码的 findAlias（与 findChinese 功能相同）
function findAlias(title) {
  if (!title) return null;
  return findChinese(title, title, title, title);
}

// Browser + Node.js 兼容导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TITLE_MAP, findChinese, findAlias, normalize };
}
if (typeof window !== 'undefined') {
  window.ANIME_TITLES = { TITLE_MAP, findChinese, findAlias, normalize };
}
