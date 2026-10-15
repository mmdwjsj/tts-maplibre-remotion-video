# 泰国府 id / 英文名 / 泰文名对照表

`provinceId` 是地图高亮的唯一依据（ISO 3166-2:TH 编码），`provinceEn` 与 `provinceTh` 只用于展示与旁白。

生成页面里三列是互通的：**选府 ID 会自动带出英文名与泰文名；输入或选择泰文名（或英文名）会自动回填府 ID 和另一列**。候选来自本表，所以正常情况下不需要手打。

排名数据里 id 与名称必须指向同一个府：写错 id 会让地图高亮到另一个府，而标签显示的还是你填的名字。生成前会校验，`npm run validate:data -- --strict-naming` 可以直接拦住。

共 77 个行政区域。表格由 `node scripts/data/fill-thai-names.mjs` 写入边界数据后生成，改动边界数据请同步本表。

| id | 英文名 | 泰文名 |
| --- | --- | --- |
| TH-10 | Bangkok | กรุงเทพมหานคร |
| TH-11 | Samut Prakan | สมุทรปราการ |
| TH-12 | Nonthaburi | นนทบุรี |
| TH-13 | Pathum Thani | ปทุมธานี |
| TH-14 | Phra Nakhon Si Ayutthaya | พระนครศรีอยุธยา |
| TH-15 | Ang Thong | อ่างทอง |
| TH-16 | Lop Buri | ลพบุรี |
| TH-17 | Sing Buri | สิงห์บุรี |
| TH-18 | Chai Nat | ชัยนาท |
| TH-19 | Saraburi | สระบุรี |
| TH-20 | Chon Buri | ชลบุรี |
| TH-21 | Rayong | ระยอง |
| TH-22 | Chanthaburi | จันทบุรี |
| TH-23 | Trat | ตราด |
| TH-24 | Chachoengsao | ฉะเชิงเทรา |
| TH-25 | Prachin Buri | ปราจีนบุรี |
| TH-26 | Nakhon Nayok | นครนายก |
| TH-27 | Sa Kaeo | สระแก้ว |
| TH-30 | Nakhon Ratchasima | นครราชสีมา |
| TH-31 | Buri Ram | บุรีรัมย์ |
| TH-32 | Surin | สุรินทร์ |
| TH-33 | Si Sa Ket | ศรีสะเกษ |
| TH-34 | Ubon Ratchathani | อุบลราชธานี |
| TH-35 | Yasothon | ยโสธร |
| TH-36 | Chaiyaphum | ชัยภูมิ |
| TH-37 | Amnat Charoen | อำนาจเจริญ |
| TH-38 | Bueng Kan | บึงกาฬ |
| TH-39 | Nong Bua Lam Phu | หนองบัวลำภู |
| TH-40 | Khon Kaen | ขอนแก่น |
| TH-41 | Udon Thani | อุดรธานี |
| TH-42 | Loei | เลย |
| TH-43 | Nong Khai | หนองคาย |
| TH-44 | Maha Sarakham | มหาสารคาม |
| TH-45 | Roi Et | ร้อยเอ็ด |
| TH-46 | Kalasin | กาฬสินธุ์ |
| TH-47 | Sakon Nakhon | สกลนคร |
| TH-48 | Nakhon Phanom | นครพนม |
| TH-49 | Mukdahan | มุกดาหาร |
| TH-50 | Chiang Mai | เชียงใหม่ |
| TH-51 | Lamphun | ลำพูน |
| TH-52 | Lampang | ลำปาง |
| TH-53 | Uttaradit | อุตรดิตถ์ |
| TH-54 | Phrae | แพร่ |
| TH-55 | Nan | น่าน |
| TH-56 | Phayao | พะเยา |
| TH-57 | Chiang Rai | เชียงราย |
| TH-58 | Mae Hong Son | แม่ฮ่องสอน |
| TH-60 | Nakhon Sawan | นครสวรรค์ |
| TH-61 | Uthai Thani | อุทัยธานี |
| TH-62 | Kamphaeng Phet | กำแพงเพชร |
| TH-63 | Tak | ตาก |
| TH-64 | Sukhothai | สุโขทัย |
| TH-65 | Phitsanulok | พิษณุโลก |
| TH-66 | Phichit | พิจิตร |
| TH-67 | Phetchabun | เพชรบูรณ์ |
| TH-70 | Ratchaburi | ราชบุรี |
| TH-71 | Kanchanaburi | กาญจนบุรี |
| TH-72 | Suphan Buri | สุพรรณบุรี |
| TH-73 | Nakhon Pathom | นครปฐม |
| TH-74 | Samut Sakhon | สมุทรสาคร |
| TH-75 | Samut Songkhram | สมุทรสงคราม |
| TH-76 | Phetchaburi | เพชรบุรี |
| TH-77 | Prachuap Khiri Khan | ประจวบคีรีขันธ์ |
| TH-80 | Nakhon Si Thammarat | นครศรีธรรมราช |
| TH-81 | Krabi | กระบี่ |
| TH-82 | Phangnga | พังงา |
| TH-83 | Phuket | ภูเก็ต |
| TH-84 | Surat Thani | สุราษฎร์ธานี |
| TH-85 | Ranong | ระนอง |
| TH-86 | Chumphon | ชุมพร |
| TH-90 | Songkhla | สงขลา |
| TH-91 | Satun | สตูล |
| TH-92 | Trang | ตรัง |
| TH-93 | Phatthalung | พัทลุง |
| TH-94 | Pattani | ปัตตานี |
| TH-95 | Yala | ยะลา |
| TH-96 | Narathiwat | นราธิวาส |
